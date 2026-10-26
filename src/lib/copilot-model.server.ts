// Single model adapter for Rentropy Copilot. Every model call in the app goes
// through callModel(), so the model or provider can be swapped here alone.
// The model ID comes from COPILOT_DRAFT_MODEL; the gateway SDK reads its API
// key (LOVABLE_API_KEY) from the server environment. No key lives in code.
import { generateResponse, GatewayError, type ResponsesRequest } from "@lovable.dev/ai-gateway";

type DraftModel = ResponsesRequest["model"];

const DEFAULT_DRAFT_MODEL: DraftModel = "openai/gpt-6-astra";

const SUPPORTED_DRAFT_MODELS: readonly DraftModel[] = [
  "openai/gpt-6-astra",
  "openai/gpt-5.5",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
];

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly modelId: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

export function resolveDraftModelId(): DraftModel {
  const configured = process.env["COPILOT_DRAFT_MODEL"]?.trim();
  if (!configured) return DEFAULT_DRAFT_MODEL;
  const match = SUPPORTED_DRAFT_MODELS.find((m) => m === configured);
  if (!match) {
    throw new ModelCallError(
      `Unsupported COPILOT_DRAFT_MODEL "${configured}"`,
      configured,
      "unsupported_model",
    );
  }
  return match;
}

export async function callModel(args: {
  instructions: string;
  input: string;
}): Promise<{ text: string; modelId: string }> {
  const modelId = resolveDraftModelId();
  try {
    const response = await generateResponse({
      model: modelId,
      instructions: args.instructions,
      input: args.input,
      reasoning: { effort: "low" },
    });
    const text = response.output
      .flatMap((item) => (item.type === "message" ? item.content : []))
      .map((part) => (part.type === "output_text" ? part.text : ""))
      .join("")
      .trim();
    if (!text) throw new ModelCallError("Model returned an empty draft", modelId, "empty_output");
    return { text, modelId };
  } catch (error) {
    if (error instanceof ModelCallError) throw error;
    if (error instanceof GatewayError) {
      console.error("[copilot] model call failed", error.code, error.ids);
      throw new ModelCallError(error.message, modelId, String(error.code));
    }
    console.error("[copilot] model call failed", error);
    throw new ModelCallError("Model call failed", modelId, "unknown");
  }
}
