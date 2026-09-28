import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Not, Repository } from 'typeorm';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLogger } from '../../../common/services/logger.service';
import { dialectVariants } from '../../../common/utils/chat-id-dialects';
import { KeyedMutationQueue } from '../../../common/utils/keyed-mutation-queue';
import { EngineRegistry } from '../../../engine/engine-registry.service';
import { PLUGIN_MESSAGE_PORT, type PluginMessagePort } from '../../../core/plugins/plugin-host-ports';
import { Message, MessageDirection, MessageStatus } from '../../message/entities/message.entity';
import { AiBotChat } from './ai-bot-chat.entity';
import { AiBotConfig, nameHasMarker, resolveAiBotConfig } from './ai-bot.config';
import { AiBotInstructions } from './ai-bot-instructions';
import { ChatMessage, ChatTool, ChatToolCall, createChatCompletion } from './openai-chat.client';

/** Same freshness cut as the autoreply rules: a reconnect's backlog replay must not be answered. */
const MAX_MESSAGE_AGE_SECONDS = 300;

/** Model rounds per reply; each round may call tools. Bounds a model stuck calling tools forever. */
const MAX_TOOL_ROUNDS = 4;

/** Inbound kinds that are events rather than something said to the assistant. */
const IGNORED_TYPES = new Set(['revoked', 'call', 'masked', 'unknown']);

const TYPE_LABELS: Record<string, string> = {
  image: 'imagem',
  video: 'vídeo',
  audio: 'áudio',
  voice: 'áudio de voz',
  document: 'documento',
  sticker: 'figurinha',
  location: 'localização',
  contact: 'contato',
  poll: 'enquete',
};

const HANDOFF_FALLBACK_TEXT = 'Certo. Vou encaminhar seu atendimento para uma pessoa da equipe.';

/** How the next reply is framed; decided per turn from the chat's state. */
export type AiBotMode = 'follow_up' | 'introduce' | 'conversation';

const TOOLS: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'registrar_nome',
      description: 'Registra como a pessoa quer ser chamada. Use assim que ela informar o nome.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'O nome exatamente como a pessoa pediu para ser chamada.' },
        },
        required: ['nome'],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: 'function',
    function: {
      name: 'transferir_para_humano',
      description:
        'Encaminha a conversa para uma pessoa da equipe e encerra o atendimento automático nesta conversa. ' +
        'Use quando a pessoa pedir para falar com alguém ou quando as regras mandarem encaminhar.',
      parameters: {
        type: 'object',
        properties: { motivo: { type: 'string', description: 'Motivo curto do encaminhamento, para a equipe.' } },
        required: ['motivo'],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];

const CLASSIFIER_PROMPT = [
  'Você classifica mensagens recebidas no WhatsApp logo depois de uma mensagem que nós enviamos.',
  '"automatica": enviada sozinha pelo WhatsApp Business do contato, sem uma pessoa digitar — saudação automática',
  '("Olá! Obrigado por entrar em contato", "Em breve retornaremos"), mensagem de ausência ou fora do horário,',
  'menu automático ("Digite 1 para...") ou confirmação automática de recebimento.',
  '"humana": qualquer coisa escrita por uma pessoa, inclusive cumprimentos curtos ("oi", "bom dia", "quem é?"),',
  'perguntas e respostas ao conteúdo da nossa mensagem.',
  'Respostas automáticas costumam chegar poucos segundos depois da nossa mensagem e ter texto genérico de empresa.',
  'Na dúvida, responda "humana".',
].join(' ');

/**
 * The follow-up is written WITHOUT the assistant's prompt and knowledge base, on purpose: that prompt
 * says to introduce itself on first contact, and a per-turn "not this time" appended after it was
 * obeyed only some of the time. A dedicated prompt with no such rule is deterministic about it.
 */
const FOLLOW_UP_PROMPT = [
  'Você escreve a mensagem de retomada de uma conversa comercial no WhatsApp.',
  'Nós enviamos ao contato a mensagem indicada; o que voltou foi só a resposta automática do WhatsApp Business dele,',
  'e ninguém leu ainda.',
  'Escreva UMA mensagem curta (uma ou duas frases), em português do Brasil, no tom de um vendedor cordial, que retome',
  'o assunto da nossa mensagem e pergunte se há interesse em saber mais sobre a solução.',
  'Regras: não se apresente como assistente virtual nem como bot; não afirme ser uma pessoa e não invente nome;',
  'não comente nem agradeça a resposta automática; não invente preço, prazo, promoção nem resultado; sem emojis;',
  'responda somente com o texto da mensagem.',
].join(' ');

/**
 * LLM assistant for WhatsApp chats, gated to contacts whose saved name carries a marker.
 *
 * Runs off the projector's inbound dispatch, like the autoreply rules, and follows the same
 * contract: fire-and-forget, never throws into the receive path, fresh messages only, never answers
 * its own messages. The reply goes out through the ordinary send path with `automated: true`, so it
 * is paced, typing-simulated and — crucially — told apart from an operator's message.
 *
 * Per chat it moves through three framings:
 * - `follow_up`: the only thing that came back after our message is the contact's automatic
 *   business greeting. One short sales follow-up, sent once; the assistant does not introduce itself
 *   there, because nobody is reading yet.
 * - `introduce`: the first reply to a real person. The assistant says it is a virtual assistant.
 * - `conversation`: everything after that.
 *
 * It goes silent for good in a chat when it hands off (its own tool, or the hourly reply cap) or
 * when an operator sends into the chat after the assistant's first reply; only the resume endpoint
 * brings it back.
 */
@Injectable()
export class AiBotService {
  private readonly logger = createLogger('AiBotService');
  private readonly queue = new KeyedMutationQueue((key, err) =>
    this.logger.warn('AI bot chat work failed', { key, error: err instanceof Error ? err.message : String(err) }),
  );
  /** `${sessionId}:${chatId}` -> id of the newest inbound message still waiting for an answer. */
  private readonly latestInbound = new Map<string, string>();
  private readonly warned = new Set<string>();
  private instructions?: { key: string; loader: AiBotInstructions };
  private messagePort?: PluginMessagePort;

  constructor(
    @InjectRepository(AiBotChat, 'data')
    private readonly chatRepository: Repository<AiBotChat>,
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly engines: EngineRegistry,
    @Optional()
    private readonly moduleRef?: ModuleRef,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  /**
   * Entry point from the projector. Resolves when this message's work is done (or skipped), which
   * only the specs wait for; the projector fires and forgets.
   */
  async handleInbound(sessionId: string, message: Record<string, unknown>): Promise<void> {
    const config = resolveAiBotConfig(this.configService);
    if (!config.enabled) return;
    if (message.fromMe === true) return;
    const chatId = typeof message.chatId === 'string' ? message.chatId : null;
    const messageId = typeof message.id === 'string' && message.id ? message.id : null;
    if (!chatId || !messageId || !isOneToOneChat(message, chatId)) return;
    if (IGNORED_TYPES.has(String(message.type))) return;
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : null;
    if (timestamp !== null && Date.now() / 1000 - timestamp > MAX_MESSAGE_AGE_SECONDS) return;
    if (!config.apiKey) {
      this.warnOnce('no-key', 'AI bot is enabled but AI_BOT_OPENAI_API_KEY is not set; not replying');
      return;
    }

    const contactIds = contactLookupIds(chatId, message);
    // Checked before the debounce too, so a chat that is not the bot's costs one lookup and no timer.
    if (!(await this.isMarkedContact(sessionId, contactIds, config))) return;

    const key = `${sessionId}:${chatId}`;
    this.latestInbound.set(key, messageId);
    if (config.debounceMs > 0) await sleep(config.debounceMs);
    // A newer message arrived during the quiet period; its own run answers the whole burst.
    if (this.latestInbound.get(key) !== messageId) return;

    await new Promise<void>(resolve => {
      this.queue.enqueue(key, async () => {
        try {
          if (this.latestInbound.get(key) !== messageId) return;
          await this.respond(sessionId, chatId, contactIds, config);
        } finally {
          if (this.latestInbound.get(key) === messageId) this.latestInbound.delete(key);
          resolve();
        }
      });
    });
  }

  /** The assistant's per-chat state rows of a session, most recently active first. */
  async listChats(sessionId: string): Promise<AiBotChat[]> {
    return this.chatRepository.find({ where: { sessionId }, order: { updatedAt: 'DESC', id: 'ASC' } });
  }

  /**
   * Give a handed-off chat back to the assistant. The takeover baseline moves to now, so the
   * operator messages that caused (or followed) the handoff do not immediately silence it again.
   */
  async resumeChat(sessionId: string, chatId: string): Promise<AiBotChat> {
    const state = await this.chatRepository.findOne({ where: { sessionId, chatId: In(dialectVariants(chatId)) } });
    if (!state) throw new NotFoundException(`No assistant state for chat ${chatId} in this session`);
    state.handoffAt = null;
    state.handoffReason = null;
    state.firstReplyAt = new Date();
    return this.chatRepository.save(state);
  }

  private async respond(sessionId: string, chatId: string, contactIds: string[], config: AiBotConfig): Promise<void> {
    try {
      // Verified again right before answering: the operator may have renamed the contact since.
      if (!(await this.isMarkedContact(sessionId, contactIds, config))) return;

      const instructions = await this.instructionsFor(config).load();
      if (!instructions) {
        this.warnOnce(
          'no-instructions',
          'AI bot has no instructions (AI_BOT_SYSTEM_PROMPT_FILE / AI_BOT_KNOWLEDGE_DIR missing or empty); not replying',
        );
        return;
      }

      const state = await this.loadState(sessionId, chatId);
      if (state.handoffAt) return;

      const variants = dialectVariants(chatId);
      if (state.firstReplyAt && (await this.humanTookOver(sessionId, variants, state.firstReplyAt))) {
        await this.markHandoff(state, 'Um atendente respondeu nesta conversa');
        this.logger.log('AI bot silenced: an operator replied in the chat', { sessionId, chatId });
        return;
      }
      if (await this.overReplyBudget(sessionId, variants, config)) {
        await this.markHandoff(state, `Limite de ${config.maxRepliesPerHour} respostas automáticas por hora atingido`);
        await this.notifyHandoff(sessionId, chatId, state, config);
        return;
      }

      const history = await this.loadHistory(sessionId, variants, config.historyLimit);
      const lastOutgoingIndex = findLastIndex(history, row => row.direction === MessageDirection.OUTGOING);
      const pending = history.slice(lastOutgoingIndex + 1);
      // Nothing unanswered: an operator (or an earlier run) already answered the latest message.
      if (pending.length === 0) return;

      const lastOutgoing = lastOutgoingIndex >= 0 ? history[lastOutgoingIndex] : null;
      const mode = await this.decideMode(state, lastOutgoing, pending, config);
      if (!mode) return;

      const reply =
        mode === 'follow_up' && lastOutgoing
          ? await this.generateFollowUp(lastOutgoing, pending, config)
          : await this.generateReply(mode === 'follow_up' ? 'introduce' : mode, state, history, instructions, config);
      if (!reply) return;

      const sentAt = new Date();
      await this.resolveMessagePort()?.sendText(sessionId, { chatId, text: reply.text }, { automated: true });
      state.firstReplyAt ??= sentAt;
      if (mode === 'follow_up') state.followUpSentAt = sentAt;
      if (mode === 'introduce') state.introducedAt = sentAt;
      await this.chatRepository.save(state);
      this.logger.log('AI bot replied', { sessionId, chatId, mode });

      if (reply.handedOff) await this.notifyHandoff(sessionId, chatId, state, config);
    } catch (error) {
      this.logger.warn('AI bot reply failed', {
        sessionId,
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Null means "stay silent": the contact's automatic greeting keeps firing but the one follow-up it
   * warrants was already sent.
   */
  private async decideMode(
    state: AiBotChat,
    lastOutgoing: Message | null,
    pending: Message[],
    config: AiBotConfig,
  ): Promise<AiBotMode | null> {
    if (state.introducedAt) return 'conversation';
    // An automatic business reply only ever answers something WE sent; with nothing sent, a person wrote first.
    if (!lastOutgoing) return 'introduce';
    const origin = await this.classifyPending(lastOutgoing, pending, config);
    if (origin === 'automatica') return state.followUpSentAt ? null : 'follow_up';
    return 'introduce';
  }

  /**
   * Automatic business reply vs a person. Any failure reads as a person: the cost of that mistake is
   * an early "I'm a virtual assistant", while the opposite mistake withholds it from a real person.
   */
  private async classifyPending(
    lastOutgoing: Message,
    pending: Message[],
    config: AiBotConfig,
  ): Promise<'automatica' | 'humana'> {
    const texts = pending.map(row => describeMessage(row)).filter((text): text is string => Boolean(text));
    if (texts.length === 0 || pending.some(row => row.type !== 'text')) return 'humana';
    const elapsedSeconds = Math.max(
      0,
      Math.round((toTime(pending[0].createdAt) - toTime(lastOutgoing.createdAt)) / 1000),
    );
    const question = [
      `Nossa última mensagem enviada: "${describeMessage(lastOutgoing) ?? ''}"`,
      `A primeira resposta chegou ${elapsedSeconds} segundos depois dela.`,
      'Mensagens recebidas depois dela:',
      ...texts.map((text, index) => `${index + 1}. "${text}"`),
    ].join('\n');
    try {
      const reply = await createChatCompletion(this.clientOptions(config), {
        model: config.model,
        messages: [
          { role: 'system', content: CLASSIFIER_PROMPT },
          { role: 'user', content: question },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'origem_da_mensagem',
            strict: true,
            schema: {
              type: 'object',
              properties: { origem: { type: 'string', enum: ['automatica', 'humana'] } },
              required: ['origem'],
              additionalProperties: false,
            },
          },
        },
      });
      const origin = (JSON.parse(reply.content ?? '{}') as { origem?: unknown }).origem;
      return origin === 'automatica' ? 'automatica' : 'humana';
    } catch (error) {
      this.logger.warn('AI bot classification failed; treating the message as written by a person', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 'humana';
    }
  }

  private async generateFollowUp(
    lastOutgoing: Message,
    pending: Message[],
    config: AiBotConfig,
  ): Promise<{ text: string; handedOff: boolean } | null> {
    const received = pending
      .map(row => describeMessage(row))
      .filter((text): text is string => Boolean(text))
      .map(text => `"${text}"`)
      .join('\n');
    const reply = await createChatCompletion(this.clientOptions(config), {
      model: config.model,
      messages: [
        { role: 'system', content: FOLLOW_UP_PROMPT },
        {
          role: 'user',
          content: `Nossa mensagem:\n"${describeMessage(lastOutgoing) ?? ''}"\n\nResposta automática recebida:\n${received}`,
        },
      ],
    });
    const text = reply.content?.trim();
    return text ? { text, handedOff: false } : null;
  }

  private async generateReply(
    mode: Exclude<AiBotMode, 'follow_up'>,
    state: AiBotChat,
    history: Message[],
    instructions: string,
    config: AiBotConfig,
  ): Promise<{ text: string; handedOff: boolean } | null> {
    const messages: ChatMessage[] = [
      { role: 'system', content: instructions },
      // After the static instructions, never before: the provider caches the longest repeated
      // prefix, and this block changes from chat to chat.
      { role: 'system', content: runtimeContext(mode, state) },
      ...history.map(toChatMessage).filter((message): message is ChatMessage => message !== null),
    ];
    let handedOff = false;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const reply = await createChatCompletion(this.clientOptions(config), {
        model: config.model,
        messages,
        tools: TOOLS,
      });
      if (!reply.tool_calls?.length) {
        const text = reply.content?.trim();
        if (text) return { text, handedOff };
        return handedOff ? { text: HANDOFF_FALLBACK_TEXT, handedOff } : null;
      }
      messages.push(reply);
      for (const call of reply.tool_calls) {
        const result = await this.runTool(call, state);
        if (result.handedOff) handedOff = true;
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
      }
    }
    return handedOff ? { text: HANDOFF_FALLBACK_TEXT, handedOff } : null;
  }

  private async runTool(call: ChatToolCall, state: AiBotChat): Promise<{ content: string; handedOff?: boolean }> {
    const args = parseToolArguments(call.function.arguments);
    if (!args) return { content: 'Argumentos inválidos; nada foi feito.' };
    if (call.function.name === 'registrar_nome') {
      const name = typeof args.nome === 'string' ? args.nome.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
      if (!name) return { content: 'Nome vazio; nada foi registrado.' };
      state.customerName = name;
      await this.chatRepository.save(state);
      return { content: `Nome registrado: ${name}.` };
    }
    if (call.function.name === 'transferir_para_humano') {
      const reason =
        typeof args.motivo === 'string' && args.motivo.trim() ? args.motivo.trim() : 'Pedido de atendimento humano';
      // Persisted before the confirmation is even written: if the send fails, the chat must still
      // be the human's.
      await this.markHandoff(state, reason);
      return {
        content:
          'Transferência registrada. Responda agora apenas com uma mensagem curta confirmando o encaminhamento, sem perguntas.',
        handedOff: true,
      };
    }
    return { content: 'Ferramenta desconhecida.' };
  }

  private async isMarkedContact(sessionId: string, contactIds: string[], config: AiBotConfig): Promise<boolean> {
    const engine = this.engines.get(sessionId);
    if (!engine) return false;
    for (const id of contactIds) {
      try {
        const contact = await engine.getContactById(id);
        // Saved address-book name only (see AiBotConfig.contactMarker for why never the push name).
        if (contact) return contact.isMyContact === true && nameHasMarker(contact.name, config.contactMarker);
      } catch {
        // Unreadable contact: try the next spelling; none left means not verified, so no reply.
      }
    }
    return false;
  }

  private async loadState(sessionId: string, chatId: string): Promise<AiBotChat> {
    const existing = await this.chatRepository.findOne({ where: { sessionId, chatId } });
    return (
      existing ??
      this.chatRepository.create({
        sessionId,
        chatId,
        customerName: null,
        firstReplyAt: null,
        followUpSentAt: null,
        introducedAt: null,
        handoffAt: null,
        handoffReason: null,
      })
    );
  }

  private async markHandoff(state: AiBotChat, reason: string): Promise<void> {
    state.handoffAt = new Date();
    state.handoffReason = reason.slice(0, 300);
    await this.chatRepository.save(state);
  }

  /**
   * An operator message newer than the assistant's first reply. Bulk sends are persisted
   * `automated = false` too, so a campaign sent BEFORE the assistant got involved must not count —
   * hence the baseline, rather than the autoreply rules' "any human row ever" probe.
   */
  private humanTookOver(sessionId: string, variants: string[], since: Date): Promise<boolean> {
    return this.messageRepository.exists({
      where: variants.map(id => ({
        sessionId,
        chatId: id,
        direction: MessageDirection.OUTGOING,
        automated: false,
        createdAt: MoreThan(since),
      })),
    });
  }

  private async overReplyBudget(sessionId: string, variants: string[], config: AiBotConfig): Promise<boolean> {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const replies = await this.messageRepository.count({
      where: variants.map(id => ({
        sessionId,
        chatId: id,
        direction: MessageDirection.OUTGOING,
        automated: true,
        createdAt: MoreThan(since),
      })),
    });
    return replies >= config.maxRepliesPerHour;
  }

  private async loadHistory(sessionId: string, variants: string[], limit: number): Promise<Message[]> {
    const rows = await this.messageRepository.find({
      where: { sessionId, chatId: In(variants), status: Not(MessageStatus.FAILED) },
      order: { createdAt: 'DESC', timestamp: 'DESC' },
      take: limit,
    });
    return rows.reverse();
  }

  private async notifyHandoff(sessionId: string, chatId: string, state: AiBotChat, config: AiBotConfig): Promise<void> {
    if (!config.handoffNotifyChatId) return;
    const text = [
      '[Assistente virtual] Atendimento humano necessário',
      `Contato: ${state.customerName ?? 'nome não informado'} (${chatId.split('@')[0]})`,
      `Motivo: ${state.handoffReason ?? 'não informado'}`,
    ].join('\n');
    try {
      await this.resolveMessagePort()?.sendText(
        sessionId,
        { chatId: config.handoffNotifyChatId, text },
        { automated: true },
      );
    } catch (error) {
      this.logger.warn('AI bot handoff notice failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private instructionsFor(config: AiBotConfig): AiBotInstructions {
    const key = `${config.systemPromptFile ?? ''}|${config.knowledgeDir ?? ''}`;
    if (this.instructions?.key !== key) {
      this.instructions = { key, loader: new AiBotInstructions(config.systemPromptFile, config.knowledgeDir) };
    }
    return this.instructions.loader;
  }

  private clientOptions(config: AiBotConfig): { apiKey: string; baseUrl: string; timeoutMs: number } {
    return { apiKey: config.apiKey ?? '', baseUrl: config.baseUrl, timeoutMs: config.requestTimeoutMs };
  }

  /** Lazily, for the same module-cycle reason as AutomationRulesService.resolveMessagePort. */
  private resolveMessagePort(): PluginMessagePort | undefined {
    if (!this.messagePort) {
      try {
        this.messagePort = this.moduleRef?.get<typeof PLUGIN_MESSAGE_PORT, PluginMessagePort>(PLUGIN_MESSAGE_PORT, {
          strict: false,
        });
      } catch (error) {
        this.warnOnce('no-port', `MessageService is not resolvable; AI bot replies are disabled (${String(error)})`);
      }
    }
    return this.messagePort;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(message);
  }
}

/** Direct chats only: groups, channels, status and broadcast lists are never answered. */
function isOneToOneChat(message: Record<string, unknown>, chatId: string): boolean {
  if (message.isGroup === true || message.isStatusBroadcast === true) return false;
  if (typeof message.kind === 'string' && message.kind !== 'individual') return false;
  return /@(c\.us|s\.whatsapp\.net|lid)$/i.test(chatId);
}

/**
 * Ids to read the saved contact under. A `@lid` chat may carry no address-book name of its own, so
 * the resolved phone twin (when the engine supplied one) is tried after it.
 */
function contactLookupIds(chatId: string, message: Record<string, unknown>): string[] {
  const ids = [chatId];
  const phone = typeof message.senderPhone === 'string' ? message.senderPhone.replace(/\D/g, '') : '';
  if (chatId.toLowerCase().endsWith('@lid') && phone) ids.push(`${phone}@c.us`);
  return ids;
}

function describeMessage(row: Message): string | null {
  const body = row.body?.trim() ?? '';
  if (row.type === 'text') return body || null;
  if (IGNORED_TYPES.has(row.type)) return null;
  const label = TYPE_LABELS[row.type] ?? 'mensagem';
  return body ? `[${label}] ${body}` : `[${label} sem texto]`;
}

function toChatMessage(row: Message): ChatMessage | null {
  const content = describeMessage(row);
  if (!content) return null;
  return row.direction === MessageDirection.INCOMING ? { role: 'user', content } : { role: 'assistant', content };
}

/** Per-chat framing, sent as a second system message after the static instructions. */
export function runtimeContext(
  mode: Exclude<AiBotMode, 'follow_up'>,
  state: Pick<AiBotChat, 'customerName'>,
  now = new Date(),
): string {
  const today = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full' });
  return [
    '# CONTEXTO DESTA CONVERSA (definido pelo sistema)',
    '- Canal: WhatsApp. Escreva como mensagem de WhatsApp: curta, sem títulos, sem tabelas e sem links em Markdown. Para destacar, use *asteriscos*.',
    `- Hoje é ${today}.`,
    '- As mensagens com papel "assistant" foram enviadas por este número. A primeira delas pode ter sido um envio de campanha, e não uma resposta sua.',
    state.customerName
      ? `- A pessoa já informou como quer ser chamada: ${state.customerName}. Não pergunte de novo.`
      : '- A pessoa ainda não informou como quer ser chamada.',
    '- Ferramentas: use `registrar_nome` assim que a pessoa disser como quer ser chamada, e `transferir_para_humano` quando ela pedir para falar com alguém ou quando as regras mandarem encaminhar.',
    mode === 'introduce'
      ? '- Esta é a primeira resposta sua a uma pessoa real nesta conversa: apresente-se como assistente virtual, conforme as instruções, e responda ao que ela escreveu.'
      : '- Você já se apresentou nesta conversa; não repita a apresentação.',
  ].join('\n');
}

function parseToolArguments(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toTime(value: Date | string | number): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) return index;
  }
  return -1;
}
