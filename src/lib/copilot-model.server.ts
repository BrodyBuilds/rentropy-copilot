// Single model adapter for Rentropy Copilot. Every model call in the app goes
// through callModel() (chat/vision) or callSegmentation() (SAM), so the model,
// provider, or endpoint is swapped here alone by changing environment variables.
// Nothing about the model is hardcoded:
//   META_MODEL_API_KEY       – sent as a Bearer token (server-only, never in the browser)
//   META_MODEL_ID            – the chat model name sent in the request and recorded in the audit log
//   META_MODEL_API_BASE_URL  – the Meta Model API base URL (chat-completions and /responses)
//   META_SAM_MODEL_ID        – the segmentation (SAM) model name
// This file is *.server.ts, so it can never be bundled into the client.

import { parseSegmentationText, readResponsesText, StreamError, type ParsedSegmentation } from "./copilot-segmentation";

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
  /** Image URLs (e.g. short-lived signed links) sent alongside the user prompt. */
  images?: string[];
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
          {
            role: "user",
            content: options.images?.length
              ? [
                  { type: "text", text: userPrompt },
                  ...options.images.map((url) => ({ type: "image_url", image_url: { url } })),
                ]
              : userPrompt,
          },
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

/* ---------- Segmentation (SAM) ---------- */

/** The configured SAM model ID, or null when unset. Used for audit rows. */
export function configuredSamModelId(): string | null {
  return readEnv("META_SAM_MODEL_ID");
}

/** Names of the settings photo triage needs that are not set. */
export function missingTriageConfig(): string[] {
  return ["META_MODEL_API_KEY", "META_MODEL_ID", "META_MODEL_API_BASE_URL", "META_SAM_MODEL_ID"].filter(
    (name) => !readEnv(name),
  );
}

/** The /responses endpoint on the same base URL the chat adapter uses. */
export function responsesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  return trimmed.endsWith("/responses") ? trimmed : `${trimmed}/responses`;
}

export type SegmentationResult = ParsedSegmentation & { rawText: string; modelId: string };

/**
 * One SAM request for ONE short concept phrase (never a comma list) on one image.
 * Streams from POST {base}/responses and parses the boxes out of the output text.
 */
export async function callSegmentation(
  concept: string,
  imageUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<SegmentationResult> {
  const apiKey = readEnv("META_MODEL_API_KEY");
  const baseUrl = readEnv("META_MODEL_API_BASE_URL");
  const modelId = readEnv("META_SAM_MODEL_ID");

  if (!apiKey || !modelId || !baseUrl) {
    console.error("[copilot] segmentation not configured; missing:", missingTriageConfig().join(", "));
    throw new ModelCallError("Segmentation model is not configured", modelId, "not_configured");
  }

  let response: Response;
  try {
    response = await fetch(responsesUrl(baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: modelId,
        stream: true,
        metadata: { mask_encoding: "one_bit", include_confidence: "true" },
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: concept },
              { type: "input_image", image_url: imageUrl },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    console.error("[copilot] segmentation request failed", timedOut ? "timeout" : error);
    throw new ModelCallError("Segmentation request failed", modelId, timedOut ? "timeout" : "network");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("[copilot] segmentation API error", response.status, detail.slice(0, 500));
    throw new ModelCallError(`Segmentation API returned ${response.status}`, modelId, `http_${response.status}`);
  }

  let rawText: string;
  try {
    rawText = readResponsesText(await response.text());
  } catch (error) {
    const code = error instanceof StreamError ? "stream_error" : "invalid_response";
    console.error("[copilot] segmentation stream unreadable", error);
    throw new ModelCallError("Segmentation reply was unreadable", modelId, code);
  }
  if (!rawText) throw new ModelCallError("Segmentation returned an empty reply", modelId, "empty_output");

  return { ...parseSegmentationText(rawText), rawText, modelId };
}
