// Single model adapter for Rentropy Copilot. Every model call in the app goes
// through callModel(), so the model, provider, or endpoint is swapped here alone
// by changing environment variables. Nothing about the model is hardcoded:
//   META_MODEL_API_KEY       – sent as a Bearer token (server-only, never in the browser)
//   META_MODEL_ID            – the model name sent in the request and recorded in the audit log
//   META_MODEL_API_BASE_URL  – the chat-completions API base URL
// This file is *.server.ts, so it can never be bundled into the client.

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly modelId: string | null,
    readonly code: string,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/** The configured model ID, or null when unset. Used for audit rows. */
export function configuredModelId(): string | null {
  return readEnv("META_MODEL_ID");
}

/** Accepts either an API base (".../v1") or the full chat-completions URL. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

type ContentPart = { type?: string; text?: string };

function partsToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: ContentPart) => (typeof p?.text === "string" ? p.text : ""))
      .join("");
  }
  if (content && typeof content === "object" && "text" in content) {
    const text = (content as ContentPart).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

/** Reads the reply from a standard chat-completions response (or Meta's native shape). */
export function extractReplyText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as {
    choices?: Array<{ message?: { content?: unknown } }>;
    completion_message?: { content?: unknown };
  };
  const fromChoices = partsToText(b.choices?.[0]?.message?.content);
  if (fromChoices) return fromChoices.trim();
  return partsToText(b.completion_message?.content).trim();
}

export type CallModelOptions = {
  /** Sampling temperature; omitted from the request when unset. */
  temperature?: number;
  /** Upper bound on reply length; omitted from the request when unset. */
  maxTokens?: number;
  /** Request timeout; defaults to 30s. */
  timeoutMs?: number;
};

export async function callModel(
  systemPrompt: string,
  userPrompt: string,
  options: CallModelOptions = {},
): Promise<{ text: string; modelId: string }> {
  const apiKey = readEnv("META_MODEL_API_KEY");
  const modelId = readEnv("META_MODEL_ID");
  const baseUrl = readEnv("META_MODEL_API_BASE_URL");

  if (!apiKey || !modelId || !baseUrl) {
    const missing = [
      !apiKey && "META_MODEL_API_KEY",
      !modelId && "META_MODEL_ID",
      !baseUrl && "META_MODEL_API_BASE_URL",
    ].filter(Boolean);
    console.error("[copilot] model not configured; missing:", missing.join(", "));
    throw new ModelCallError("Model is not configured", modelId, "not_configured");
  }

  let response: Response;
  try {
    response = await fetch(chatCompletionsUrl(baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    console.error("[copilot] model request failed", timedOut ? "timeout" : error);
    throw new ModelCallError("Model request failed", modelId, timedOut ? "timeout" : "network");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("[copilot] model API error", response.status, detail.slice(0, 500));
    throw new ModelCallError(`Model API returned ${response.status}`, modelId, `http_${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ModelCallError("Model API returned invalid JSON", modelId, "invalid_response");
  }

  const text = extractReplyText(body);
  if (!text) throw new ModelCallError("Model returned an empty reply", modelId, "empty_output");
  return { text, modelId };
}
