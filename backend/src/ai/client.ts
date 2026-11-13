/**
 * The smallest OpenAI-compatible chat client that could work.
 *
 * `fetch`, not an SDK: this needs one endpoint, one request shape and one timeout. A dependency
 * would add a version to keep aligned for behaviour we do not use, and it would hide the one
 * thing worth teaching here — an AI call is just an HTTP POST with a JSON body and a bearer
 * token.
 *
 * Every provider that speaks the chat-completions shape (Freebuff, OpenAI, Z.ai, a local Ollama
 * gateway) works by changing the base URL, which is why the loop never mentions a vendor.
 */

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ChatMessage = { role: 'system' | 'user'; content: string | ContentPart[] };

export type ChatOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  messages: ChatMessage[];
};

/** A model call that failed for a reason worth reporting rather than retrying blindly. */
export class AiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'AiRequestError';
  }
}

/**
 * Ask the model for a JSON object and return it parsed.
 *
 * `response_format: json_object` plus a prompt that shows the exact shape is the combination
 * that works in practice: the flag guarantees valid JSON, the prompt teaches the fields. Parsing
 * is still wrapped, because "valid JSON" is not "the JSON we asked for" — and that second check
 * belongs to the caller, which knows the schema.
 */
export async function chatJson(options: ChatOptions): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        // Planning is not a creative task; near-zero temperature keeps step lists repeatable.
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: options.messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AiRequestError(
        `model answered HTTP ${response.status}${body === '' ? '' : `: ${body.slice(0, 200)}`}`,
        response.status,
      );
    }

    const parsed = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new AiRequestError('model returned no content', null);
    }

    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new AiRequestError('model did not return JSON', null);
    }
  } catch (error) {
    if (error instanceof AiRequestError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiRequestError(`no answer within ${options.timeoutMs} ms`, null);
    }
    throw new AiRequestError(error instanceof Error ? error.message : 'request failed', null);
  } finally {
    clearTimeout(timer);
  }
}
