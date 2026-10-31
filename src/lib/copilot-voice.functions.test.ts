// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// Runs the real transcribeVoiceNote handler with a stand-in createServerFn, auth
// middleware, adapter and Supabase client.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (input: unknown) => unknown = (x) => x;
    const builder = {
      middleware: () => builder,
      validator: (fn: (input: unknown) => unknown) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        (args: { data: unknown; context: unknown }) =>
          fn({ data: validate(args.data), context: args.context }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./copilot-model.server", () => {
  class ModelCallError extends Error {
    constructor(
      message: string,
      readonly modelId: string | null,
      readonly code: string,
    ) {
      super(message);
    }
  }
  return {
    ModelCallError,
    callTranscription: vi.fn(),
    configuredVoiceModelId: () => "voice-test-model",
    missingVoiceConfig: vi.fn(() => []),
  };
});

import { callTranscription, missingVoiceConfig, ModelCallError } from "./copilot-model.server";
import { encodeWavMono16, voiceNotePath, VOICE_FAILED_MESSAGE, VOICE_NO_SPEECH_MESSAGE } from "./copilot-voice";
import { transcribeVoiceNote } from "./copilot-voice.functions";

const USER = "11111111-1111-4111-8111-111111111111";
const TENANT = "00000000-0000-4000-8000-000000000002";
const PATH = voiceNotePath(USER, TENANT, "44444444-4444-4444-8444-444444444444");

function fakeSupabase() {
  const audits: Array<Record<string, unknown>> = [];
  const writes: string[] = [];
  const wav = new Blob([encodeWavMono16(new Float32Array(24_000), 24_000)], { type: "audio/wav" });
  const client = {
    storage: { from: () => ({ download: async () => ({ data: wav, error: null }) }) },
    from(table: string) {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: { id: TENANT }, error: null }),
        insert: async (payload: Record<string, unknown>) => {
          writes.push(table);
          if (table === "copilot_audit_log") audits.push(payload);
          return { data: null, error: null };
        },
        update: () => {
          writes.push(table);
          return b;
        },
      };
      return b;
    },
  };
  return { client, audits, writes };
}

type Fn = (args: { data: unknown; context: unknown }) => Promise<unknown>;
const run = (client: unknown, path = PATH) =>
  (transcribeVoiceNote as unknown as Fn)({
    data: { tenant_id: TENANT, audio_path: path },
    context: { supabase: client, userId: USER },
  });

beforeEach(() => {
  vi.mocked(callTranscription).mockReset();
  vi.mocked(missingVoiceConfig).mockReturnValue([]);
});

describe("transcribeVoiceNote", () => {
  it("returns the transcript verbatim and writes one voice_transcribe row with the voice model and tenant", async () => {
    const transcript = "  hi um, the ceiling's dripping again..  ";
    vi.mocked(callTranscription).mockResolvedValue({
      transcript,
      modelId: "voice-test-model",
      audioDurationMs: 1000,
      sessionId: "s1",
    });
    const { client, audits, writes } = fakeSupabase();

    const result = await run(client);
    expect(result).toEqual({ ok: true, transcript, modelId: "voice-test-model" });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "voice_transcribe", model_id: "voice-test-model", tenant_id: TENANT });
    expect((audits[0]!["detail"] as Record<string, unknown>)["transcript"]).toBe(transcript);
    // Only the audit row is written: no draft, no triage row.
    expect(writes).toEqual(["copilot_audit_log"]);
  });

  it("on a failed call writes model_error and returns the plain retry message, no transcript", async () => {
    vi.mocked(callTranscription).mockRejectedValue(new ModelCallError("boom", "voice-test-model", "http_500"));
    const { client, audits } = fakeSupabase();

    const result = await run(client);
    expect(result).toEqual({ ok: false, reason: "failed", error: VOICE_FAILED_MESSAGE });
    expect(VOICE_FAILED_MESSAGE).toBe("Couldn't transcribe that audio just now — please try again.");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "model_error", model_id: "voice-test-model", tenant_id: TENANT });
    expect(audits[0]!["detail"]).toMatchObject({ stage: "voice_transcribe", error_code: "transcription_http_500" });
  });

  it("fails honestly with model_error when the voice model setting is missing, without calling the model", async () => {
    vi.mocked(missingVoiceConfig).mockReturnValue(["META_VOICE_MODEL_ID"]);
    const { client, audits } = fakeSupabase();

    const result = await run(client);
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(callTranscription).not.toHaveBeenCalled();
    expect(audits[0]).toMatchObject({ action: "model_error" });
    expect(audits[0]!["detail"]).toMatchObject({ error_code: "not_configured" });
  });

  it("reports no speech when the transcript is empty and hands back no text", async () => {
    vi.mocked(callTranscription).mockResolvedValue({
      transcript: "",
      modelId: "voice-test-model",
      audioDurationMs: 2000,
      sessionId: null,
    });
    const { client, audits } = fakeSupabase();

    const result = await run(client);
    expect(result).toEqual({ ok: false, reason: "no_speech", error: VOICE_NO_SPEECH_MESSAGE });
    expect(audits[0]).toMatchObject({ action: "voice_transcribe" });
    expect(audits[0]!["detail"]).toMatchObject({ outcome: "no_speech" });
  });

  it("refuses a file outside the landlord's own folder without calling the model", async () => {
    const { client, audits } = fakeSupabase();
    const other = voiceNotePath("99999999-9999-4999-8999-999999999999", TENANT, "44444444-4444-4444-8444-444444444444");

    const result = await run(client, other);
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(callTranscription).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });
});
