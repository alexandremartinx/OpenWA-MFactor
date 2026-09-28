// The assistant's contract, against a real in-memory DB and a scripted model: it answers only saved
// contacts carrying the marker, follows up once on an automatic business greeting without
// introducing itself, introduces itself to the first real person, and goes silent for good on a
// handoff or an operator message. The model is a fake `fetch`; nothing leaves the process.
import { DataSource } from 'typeorm';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleRef } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { AiBotService } from './ai-bot.service';
import { AiBotChat } from './ai-bot-chat.entity';
import { AiBotConfig, computeAiBotConfig } from './ai-bot.config';
import { Session, SessionStatus } from '../../session/entities/session.entity';
import { Message, MessageDirection, MessageStatus } from '../../message/entities/message.entity';
import { EngineRegistry } from '../../../engine/engine-registry.service';
import type { IWhatsAppEngine, Contact } from '../../../engine/interfaces/whatsapp-engine.interface';

const CHAT = '5511999990000@c.us';

type ModelBody = {
  messages: Array<{ role: string; content: string | null }>;
  tools?: unknown[];
  response_format?: unknown;
};
type ModelMessage = { content?: string | null; tool_calls?: unknown[] };

describe('AiBotService', () => {
  let ds: DataSource;
  let dir: string;
  let config: AiBotConfig;
  let service: AiBotService;
  let contacts: Record<string, Contact | null>;
  let sends: Array<{ chatId: string; text: string; automated?: boolean }>;
  let modelCalls: ModelBody[];
  let classifierAnswer: 'automatica' | 'humana' | 'error';
  let replies: ModelMessage[];
  let fetchSpy: jest.SpyInstance;
  let contactLookup: jest.Mock;
  let seq: number;

  const at = (secondsAgo: number): Date => new Date(Date.now() - secondsAgo * 1000);
  // SQLite stores CreateDateColumn values in UTC without the T/Z; the specs pin them explicitly so
  // the takeover baseline and history order are deterministic.
  const sqliteTime = (date: Date): string => date.toISOString().replace('T', ' ').replace('Z', '');

  const row = async (over: Partial<Message> & { createdAt?: Date }): Promise<Message> => {
    const repo = ds.getRepository(Message);
    const { createdAt, ...fields } = over;
    seq += 1;
    const saved = await repo.save(
      repo.create({
        sessionId: 'sessA',
        waMessageId: `wamid.${seq}`,
        chatId: CHAT,
        from: CHAT,
        to: 'me',
        body: 'oi',
        type: 'text',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.SENT,
        automated: false,
        ...fields,
      }),
    );
    await ds.query(`UPDATE "messages" SET "createdAt" = ? WHERE "id" = ?`, [
      sqliteTime(createdAt ?? new Date()),
      saved.id,
    ]);
    return saved;
  };

  /** Persist an inbound row the way the projector does, then dispatch it. */
  const receive = async (body: string, over: Partial<Message> & { createdAt?: Date } = {}): Promise<void> => {
    const saved = await row({ body, ...over });
    await service.handleInbound('sessA', {
      id: saved.waMessageId,
      chatId: saved.chatId,
      from: saved.chatId,
      body,
      type: saved.type,
      fromMe: false,
      isGroup: false,
      kind: 'individual',
      timestamp: Math.floor(Date.now() / 1000),
    });
  };

  const state = (): Promise<AiBotChat | null> =>
    ds.getRepository(AiBotChat).findOne({ where: { sessionId: 'sessA', chatId: CHAT } });

  const replyCalls = (): ModelBody[] => modelCalls.filter(call => !call.response_format);
  const runtimeOf = (call: ModelBody): string => call.messages[1]?.content ?? '';

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message, AiBotChat],
      synchronize: true,
    });
    await ds.initialize();
    const sessions = ds.getRepository(Session);
    await sessions.save(sessions.create({ id: 'sessA', name: 'sessA', status: SessionStatus.READY, config: {} }));
    seq = 0;

    dir = mkdtempSync(join(tmpdir(), 'ai-bot-'));
    writeFileSync(join(dir, 'prompt.md'), 'Você é o Oracle Bot.');
    mkdirSync(join(dir, 'kb'));
    writeFileSync(join(dir, 'kb', '01-visao-geral.md'), 'O Oracle gerencia Google Ads.');
    writeFileSync(join(dir, 'kb', 'README.md'), 'NOTAS INTERNAS DO MANTENEDOR');

    config = {
      ...computeAiBotConfig({}),
      enabled: true,
      apiKey: 'sk-test',
      systemPromptFile: join(dir, 'prompt.md'),
      knowledgeDir: join(dir, 'kb'),
      debounceMs: 0,
      handoffNotifyChatId: '5511888880000@c.us',
    };

    contacts = {
      [CHAT]: {
        id: CHAT,
        name: 'Carlos Agência - envio bot',
        number: '5511999990000',
        isMyContact: true,
        isBlocked: false,
      },
    };
    contactLookup = jest.fn((id: string) => Promise.resolve(contacts[id] ?? null));
    const engines = new EngineRegistry();
    engines.set('sessA', {
      getContactById: contactLookup,
    } as unknown as IWhatsAppEngine);

    sends = [];
    const moduleRef = {
      get: () => ({
        sendText: async (_sessionId: string, dto: { chatId: string; text: string }, opts?: { automated?: boolean }) => {
          sends.push({ chatId: dto.chatId, text: dto.text, automated: opts?.automated });
          // The real send path persists the outbound row, which the next turn reads as history.
          await row({
            chatId: dto.chatId,
            body: dto.text,
            direction: MessageDirection.OUTGOING,
            automated: !!opts?.automated,
          });
          return {};
        },
      }),
    } as unknown as ModuleRef;
    const configService = { get: (key: string) => (key === 'aiBot' ? config : undefined) } as unknown as ConfigService;

    modelCalls = [];
    classifierAnswer = 'humana';
    replies = [];
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation((_url, init) => {
      const body = JSON.parse(init?.body as string) as ModelBody;
      modelCalls.push(body);
      if (body.response_format) {
        if (classifierAnswer === 'error') return Promise.resolve(new Response('boom', { status: 500 }));
        return Promise.resolve(
          new Response(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify({ origem: classifierAnswer }) } }] }),
          ),
        );
      }
      const message = replies.shift() ?? { content: 'Resposta padrão.' };
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message }] })));
    });

    service = new AiBotService(
      ds.getRepository(AiBotChat),
      ds.getRepository(Message),
      engines,
      moduleRef,
      configService,
    );
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await ds.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('who it answers', () => {
    it('stays out entirely while disabled', async () => {
      config.enabled = false;
      await receive('oi');
      expect(modelCalls).toHaveLength(0);
      expect(sends).toHaveLength(0);
    });

    it('does not answer a saved contact without the marker', async () => {
      contacts[CHAT] = {
        id: CHAT,
        name: 'Carlos Agência',
        number: '5511999990000',
        isMyContact: true,
        isBlocked: false,
      };
      await receive('oi');
      expect(modelCalls).toHaveLength(0);
      expect(sends).toHaveLength(0);
    });

    it('ignores the marker in a push name — the sender controls that one', async () => {
      contacts[CHAT] = {
        id: CHAT,
        name: undefined,
        pushName: 'Eu - envio bot',
        number: '5511999990000',
        isMyContact: false,
        isBlocked: false,
      };
      await receive('oi');
      expect(sends).toHaveLength(0);
    });

    it('matches the marker case-insensitively and ignores extra spaces', async () => {
      contacts[CHAT] = {
        id: CHAT,
        name: 'Carlos -  ENVIO   Bot',
        number: '5511999990000',
        isMyContact: true,
        isBlocked: false,
      };
      await receive('oi');
      expect(sends).toHaveLength(1);
    });

    it('re-checks the contact right before answering', async () => {
      await receive('oi');
      // Once to decide whether to queue the work, once more right before generating the reply.
      expect(contactLookup).toHaveBeenCalledTimes(2);
    });

    it('never answers groups, its own messages or stale backlog', async () => {
      await service.handleInbound('sessA', {
        id: 'g1',
        chatId: '1203@g.us',
        type: 'text',
        isGroup: true,
        fromMe: false,
      });
      await service.handleInbound('sessA', { id: 'm1', chatId: CHAT, type: 'text', fromMe: true });
      await service.handleInbound('sessA', {
        id: 'old',
        chatId: CHAT,
        type: 'text',
        fromMe: false,
        timestamp: Math.floor(Date.now() / 1000) - 3600,
      });
      expect(sends).toHaveLength(0);
    });

    it('does not reply without instructions, rather than answering from general knowledge', async () => {
      config.systemPromptFile = null;
      config.knowledgeDir = join(dir, 'missing');
      await receive('oi');
      expect(sends).toHaveLength(0);
    });
  });

  describe('instructions', () => {
    it('sends the prompt and the knowledge base, but never the README', async () => {
      await receive('oi');
      const system = replyCalls()[0].messages[0].content ?? '';
      expect(system).toContain('Você é o Oracle Bot.');
      expect(system).toContain('O Oracle gerencia Google Ads.');
      expect(system).not.toContain('NOTAS INTERNAS');
    });
  });

  describe('automatic greeting vs a real person', () => {
    it('follows up once, without introducing itself, on the automatic greeting to our campaign message', async () => {
      await row({ body: 'Olá! Conheça o Oracle.', direction: MessageDirection.OUTGOING, createdAt: at(10) });
      classifierAnswer = 'automatica';
      replies.push({ content: 'Oi! Vi que recebeu nossa mensagem sobre o Oracle. Tem interesse em saber mais?' });

      await receive('Olá! Obrigado por entrar em contato. Em breve retornaremos.', { createdAt: at(8) });

      expect(sends).toEqual([
        {
          chatId: CHAT,
          text: 'Oi! Vi que recebeu nossa mensagem sobre o Oracle. Tem interesse em saber mais?',
          automated: true,
        },
      ]);
      const call = replyCalls()[0];
      // Written from a dedicated prompt, never the assistant's: that one says to introduce itself on
      // first contact, which is exactly what this message must not do.
      expect(call.tools).toBeUndefined();
      const [system, user] = call.messages.map(message => message.content ?? '');
      expect(system).toContain('não se apresente como assistente virtual');
      expect(system).toContain('não afirme ser uma pessoa');
      expect(system).not.toContain('Você é o Oracle Bot.');
      expect(system).not.toContain('O Oracle gerencia Google Ads.');
      expect(user).toContain('Olá! Conheça o Oracle.');
      expect(user).toContain('Obrigado por entrar em contato');
      const saved = await state();
      expect(saved?.followUpSentAt).toBeInstanceOf(Date);
      expect(saved?.introducedAt).toBeNull();
    });

    it('stays silent on a second automatic message after the follow-up', async () => {
      await row({ body: 'Olá! Conheça o Oracle.', direction: MessageDirection.OUTGOING, createdAt: at(20) });
      classifierAnswer = 'automatica';
      await receive('Olá! Obrigado por entrar em contato.', { createdAt: at(18) });
      await receive('Nosso horário é das 9h às 18h.', { createdAt: at(0) });
      expect(sends).toHaveLength(1);
    });

    it('introduces itself as a virtual assistant when a person answers after the follow-up', async () => {
      await row({ body: 'Olá! Conheça o Oracle.', direction: MessageDirection.OUTGOING, createdAt: at(60) });
      classifierAnswer = 'automatica';
      await receive('Olá! Obrigado por entrar em contato.', { createdAt: at(58) });

      classifierAnswer = 'humana';
      replies.push({ content: 'Olá! Eu sou o Oracle Bot, assistente virtual do Oracle. Como posso te chamar?' });
      await receive('Oi, tenho interesse sim', { createdAt: at(0) });

      expect(sends).toHaveLength(2);
      const call = replyCalls()[1];
      expect(call.tools).toHaveLength(2);
      expect(runtimeOf(call)).toContain('apresente-se como assistente virtual');
      expect((await state())?.introducedAt).toBeInstanceOf(Date);
    });

    it('introduces itself when the contact writes first, without asking the classifier', async () => {
      await receive('Oi, quero saber do Oracle');
      expect(modelCalls.filter(call => call.response_format)).toHaveLength(0);
      expect(runtimeOf(replyCalls()[0])).toContain('apresente-se como assistente virtual');
    });

    it('treats a classifier failure as a person, so a real person is never denied the introduction', async () => {
      await row({ body: 'Olá! Conheça o Oracle.', direction: MessageDirection.OUTGOING, createdAt: at(10) });
      classifierAnswer = 'error';
      await receive('Olá! Obrigado por entrar em contato.', { createdAt: at(8) });
      expect(runtimeOf(replyCalls()[0])).toContain('apresente-se como assistente virtual');
    });

    it('does not re-introduce itself later in the conversation', async () => {
      await receive('Oi');
      await receive('Quanto custa?');
      expect(runtimeOf(replyCalls()[1])).toContain('não repita a apresentação');
    });
  });

  describe('tools', () => {
    it('records the name and passes it back on later turns', async () => {
      replies.push(
        {
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'registrar_nome', arguments: '{"nome":"Carlos"}' } },
          ],
        },
        { content: 'Prazer, Carlos. Como posso ajudar?' },
      );
      await receive('Pode me chamar de Carlos');
      expect((await state())?.customerName).toBe('Carlos');
      expect(sends[0].text).toBe('Prazer, Carlos. Como posso ajudar?');

      await receive('Quanto custa?');
      expect(runtimeOf(replyCalls()[2])).toContain('já informou como quer ser chamada: Carlos');
    });

    it('hands off: confirms, notifies the team chat, then stays silent', async () => {
      replies.push(
        {
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'transferir_para_humano', arguments: '{"motivo":"Pediu um atendente"}' },
            },
          ],
        },
        { content: 'Claro. Vou encaminhar seu atendimento para uma pessoa da equipe.' },
      );
      await receive('Quero falar com uma pessoa');

      expect(sends.map(send => send.chatId)).toEqual([CHAT, '5511888880000@c.us']);
      expect(sends[1].text).toContain('Pediu um atendente');
      expect(sends.every(send => send.automated)).toBe(true);
      expect((await state())?.handoffAt).toBeInstanceOf(Date);

      await receive('Alô?');
      expect(sends).toHaveLength(2);
    });

    it('confirms the handoff even when the model writes nothing after the tool call', async () => {
      replies.push(
        {
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'transferir_para_humano', arguments: '{"motivo":"x"}' } },
          ],
        },
        { content: '' },
      );
      await receive('atendente');
      expect(sends[0].text).toContain('pessoa da equipe');
    });
  });

  describe('human takeover', () => {
    it('goes silent once an operator sends into the chat after its first reply', async () => {
      await receive('Oi', { createdAt: at(30) });
      await row({
        body: 'Oi Carlos, aqui é a Ana',
        direction: MessageDirection.OUTGOING,
        automated: false,
        createdAt: at(-5),
      });
      await receive('Oi Ana!', { createdAt: at(-10) });

      expect(sends).toHaveLength(1);
      expect((await state())?.handoffReason).toContain('atendente respondeu');
    });

    it('is not silenced by the campaign message sent before it got involved', async () => {
      await row({ body: 'Campanha', direction: MessageDirection.OUTGOING, automated: false, createdAt: at(120) });
      await receive('Oi', { createdAt: at(60) });
      await receive('Quanto custa?', { createdAt: at(0) });
      expect(sends).toHaveLength(2);
    });

    it('answers again after the chat is resumed', async () => {
      replies.push({
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'transferir_para_humano', arguments: '{"motivo":"x"}' } },
        ],
      });
      await receive('atendente', { createdAt: at(60) });
      await service.resumeChat('sessA', CHAT);
      await receive('voltei', { createdAt: at(-5) });
      expect(sends.filter(send => send.chatId === CHAT)).toHaveLength(2);
    });

    it('rejects resuming a chat it never acted in', async () => {
      await expect(service.resumeChat('sessA', '5500000000000@c.us')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('bursts and loops', () => {
    it('answers a burst of messages once, reading all of them', async () => {
      config.debounceMs = 30;
      const first = row({ body: 'Oi' });
      const saved1 = await first;
      const saved2 = await row({ body: 'Tudo bem?' });
      const dispatch = (saved: Message): Promise<void> =>
        service.handleInbound('sessA', {
          id: saved.waMessageId,
          chatId: CHAT,
          type: 'text',
          fromMe: false,
          isGroup: false,
          kind: 'individual',
        });
      await Promise.all([dispatch(saved1), dispatch(saved2)]);

      expect(sends).toHaveLength(1);
      const history = replyCalls()[0]
        .messages.slice(2)
        .map(message => message.content);
      expect(history).toEqual(['Oi', 'Tudo bem?']);
    });

    it('hands the chat to a human once the hourly reply cap is reached', async () => {
      config.maxRepliesPerHour = 2;
      await receive('1');
      await receive('2');
      await receive('3');
      expect(sends.filter(send => send.chatId === CHAT)).toHaveLength(2);
      expect((await state())?.handoffReason).toContain('Limite de 2');
      expect(sends.at(-1)?.chatId).toBe('5511888880000@c.us');
    });
  });
});
