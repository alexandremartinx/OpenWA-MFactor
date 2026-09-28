/**
 * Minimal OpenAI-compatible Chat Completions client over the global `fetch` — enough for a text reply
 * with function tools and a strict-JSON classification, without pulling an SDK into the gateway.
 */

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  response_format?: Record<string, unknown>;
}

export interface ChatClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

/** Longest provider error text kept in an exception message: enough to diagnose, never a full dump. */
const MAX_ERROR_DETAIL = 300;

export class ChatCompletionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ChatCompletionError';
  }
}

/** Send one Chat Completions request and return the first choice's message. */
export async function createChatCompletion(
  options: ChatClientOptions,
  request: ChatCompletionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<Extract<ChatMessage, { role: 'assistant' }>> {
  let response: Response;
  try {
    response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new ChatCompletionError(
      `Chat completion request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const raw = await response.text();
  if (!response.ok) {
    // The provider's error body names the problem (bad model, quota, invalid key) and never echoes
    // the key back, so a trimmed copy is safe to log.
    throw new ChatCompletionError(
      `Chat completion returned HTTP ${response.status}: ${raw.slice(0, MAX_ERROR_DETAIL)}`,
      response.status,
    );
  }

  let parsed: { choices?: Array<{ message?: { content?: string | null; tool_calls?: ChatToolCall[] } }> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new ChatCompletionError('Chat completion returned a non-JSON body');
  }
  const message = parsed.choices?.[0]?.message;
  if (!message) throw new ChatCompletionError('Chat completion returned no choices');
  return {
    role: 'assistant',
    content: typeof message.content === 'string' ? message.content : null,
    ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
  };
}
