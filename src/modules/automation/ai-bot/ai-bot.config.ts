import { ConfigService } from '@nestjs/config';

/**
 * Policy for the LLM-backed WhatsApp assistant, resolved from the environment.
 *
 * Opt-in, and inert without both a key and instructions: an assistant that talks with no system
 * prompt or knowledge base answers from the model's general knowledge, which is exactly the
 * invented-fact failure the prompt forbids.
 */
export interface AiBotConfig {
  /** Default OFF, so an upgrade never starts answering chats on its own. */
  enabled: boolean;
  /** OpenAI-compatible API key. Never logged. */
  apiKey: string | null;
  model: string;
  /** Chat Completions base URL, without the trailing `/chat/completions`. */
  baseUrl: string;
  /** Markdown file holding the assistant's system prompt (identity, tone, handoff rules). */
  systemPromptFile: string | null;
  /**
   * Directory of Markdown knowledge files, loaded in file-name order after the system prompt.
   * `README.md` is skipped: in a knowledge base it is the maintainer's notes, not bot content.
   */
  knowledgeDir: string | null;
  /**
   * The bot only answers contacts whose SAVED address-book name contains this text
   * (case-insensitive). Never the push name: that one is set by the sender, so matching it would let
   * any stranger switch the bot on — and spend the API budget — by renaming their own profile.
   */
  contactMarker: string;
  /** How many stored messages of the chat are sent as conversation history. */
  historyLimit: number;
  /** Quiet period after an inbound message, so a burst of messages gets one reply that reads all of them. */
  debounceMs: number;
  /** Replies per chat per rolling hour before the bot hands the chat to a human (loop / cost breaker). */
  maxRepliesPerHour: number;
  requestTimeoutMs: number;
  /** Chat that receives a short internal notice on every handoff (e.g. the operator's own number). */
  handoffNotifyChatId: string | null;
}

export const DEFAULT_AI_BOT_MODEL = 'gpt-5.4-mini';
export const DEFAULT_AI_BOT_CONTACT_MARKER = '- envio bot';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_DEBOUNCE_MS = 4000;
const DEFAULT_MAX_REPLIES_PER_HOUR = 30;
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

function nonEmpty(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value ? value : null;
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(value) || value < min || value > max) return fallback;
  return Math.floor(value);
}

/** Derive the policy from an environment map. Pure and parameterised for testability. */
export function computeAiBotConfig(env: NodeJS.ProcessEnv = process.env): AiBotConfig {
  return {
    enabled: env.AI_BOT_ENABLED === 'true',
    apiKey: nonEmpty(env.AI_BOT_OPENAI_API_KEY),
    model: nonEmpty(env.AI_BOT_MODEL) ?? DEFAULT_AI_BOT_MODEL,
    baseUrl: (nonEmpty(env.AI_BOT_OPENAI_BASE_URL) ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    systemPromptFile: nonEmpty(env.AI_BOT_SYSTEM_PROMPT_FILE),
    knowledgeDir: nonEmpty(env.AI_BOT_KNOWLEDGE_DIR),
    // Not trimmed: the marker's leading "- " is part of what the operator typed into the contact name.
    contactMarker: env.AI_BOT_CONTACT_MARKER?.length ? env.AI_BOT_CONTACT_MARKER : DEFAULT_AI_BOT_CONTACT_MARKER,
    historyLimit: boundedInt(env.AI_BOT_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT, 1, 100),
    debounceMs: boundedInt(env.AI_BOT_DEBOUNCE_MS, DEFAULT_DEBOUNCE_MS, 0, 60_000),
    maxRepliesPerHour: boundedInt(env.AI_BOT_MAX_REPLIES_PER_HOUR, DEFAULT_MAX_REPLIES_PER_HOUR, 1, 1000),
    requestTimeoutMs: boundedInt(env.AI_BOT_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 1000, 300_000),
    handoffNotifyChatId: nonEmpty(env.AI_BOT_HANDOFF_NOTIFY_CHAT),
  };
}

/**
 * Resolve the policy, preferring the ConfigService snapshot and falling back to a live `process.env`
 * read when ConfigService is absent — the arrangement `resolveSendPacingConfig` uses, for the same
 * reason: unit tests construct services without the global ConfigModule.
 */
export function resolveAiBotConfig(configService?: Pick<ConfigService, 'get'>): AiBotConfig {
  return configService?.get<AiBotConfig>('aiBot') ?? computeAiBotConfig();
}

/** Whether a saved contact name carries the marker. Case- and repeated-space-insensitive. */
export function nameHasMarker(name: string | undefined | null, marker: string): boolean {
  if (!name) return false;
  const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const needle = normalize(marker);
  return needle.length > 0 && normalize(name).includes(needle);
}
