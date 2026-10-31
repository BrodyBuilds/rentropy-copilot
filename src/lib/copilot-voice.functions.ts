import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Json } from "@/integrations/supabase/types";
import { callTranscription, configuredVoiceModelId, missingVoiceConfig, ModelCallError } from "./copilot-model.server";
import {
  hasSpeech,
  isApiReadyWav,
  isOwnVoiceNotePath,
  MAX_VOICE_BYTES,
  MAX_VOICE_SECONDS,
  readWavInfo,
  VOICE_BUCKET,
  VOICE_FAILED_MESSAGE,
  VOICE_NO_SPEECH_MESSAGE,
} from "./copilot-voice";

export type TranscribeVoiceResult =
  | { ok: true; transcript: string; modelId: string }
  | { ok: false; reason: "no_speech" | "failed"; error: string };

/**
 * Transcribes one stored tenant voice note (already uploaded by the landlord into their
 * own folder of the private bucket). Runs only on the landlord's click. Returns the
 * transcript exactly as the model produced it; it never edits, summarizes or translates.
 * Writes no draft, triage row or other data — only a voice_transcribe or model_error audit row.
 */
export const transcribeVoiceNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ tenant_id: z.string().uuid(), audio_path: z.string().min(1).max(300) }).parse(input),
  )
  .handler(async ({ data, context }): Promise<TranscribeVoiceResult> => {
    const { supabase, userId } = context;

    const { data: tenant, error: tenantError } = await supabase
      .from("demo_tenants")
      .select("id")
      .eq("id", data.tenant_id)
      .maybeSingle();
    if (tenantError) throw new Error("Could not load tenant");
    if (!tenant) return { ok: false, reason: "failed", error: "Tenant not found." };
    if (!isOwnVoiceNotePath(data.audio_path, userId, tenant.id)) {
      return { ok: false, reason: "failed", error: VOICE_FAILED_MESSAGE };
    }

    async function fail(code: string, modelId: string | null): Promise<TranscribeVoiceResult> {
      const { error } = await supabase.from("copilot_audit_log").insert({
        tenant_id: tenant!.id,
        action: "model_error",
        model_id: modelId,
        detail: { stage: "voice_transcribe", error_code: code, audio_path: data.audio_path } as Json,
      });
      if (error) console.error("[voice] model_error audit insert failed", error);
      return { ok: false, reason: "failed", error: VOICE_FAILED_MESSAGE };
    }

    const missing = missingVoiceConfig();
    if (missing.length) {
      console.error("[voice] not configured; missing:", missing.join(", "));
      return fail("not_configured", configuredVoiceModelId());
    }

    // Read the stored file as the landlord (bucket rules: own folder only).
    const download = await supabase.storage.from(VOICE_BUCKET).download(data.audio_path);
    if (download.error || !download.data) {
      console.error("[voice] download failed", download.error);
      return fail("audio_download_failed", configuredVoiceModelId());
    }
    const audio = download.data;
    if (audio.size === 0 || audio.size > MAX_VOICE_BYTES) return fail("audio_too_large", configuredVoiceModelId());
    const info = readWavInfo(new Uint8Array(await audio.slice(0, 4096).arrayBuffer()));
    if (!isApiReadyWav(info)) return fail("invalid_audio", configuredVoiceModelId());
    if (info!.durationSeconds > MAX_VOICE_SECONDS + 1) return fail("audio_too_long", configuredVoiceModelId());

    let result: Awaited<ReturnType<typeof callTranscription>>;
    try {
      result = await callTranscription(audio);
    } catch (error) {
      const code = error instanceof ModelCallError ? error.code : "unknown";
      const modelId = error instanceof ModelCallError ? error.modelId : configuredVoiceModelId();
      return fail(`transcription_${code}`, modelId);
    }

    const speech = hasSpeech(result.transcript);
    const { error: auditError } = await supabase.from("copilot_audit_log").insert({
      tenant_id: tenant.id,
      action: "voice_transcribe",
      model_id: result.modelId,
      detail: {
        summary: speech
          ? `Voice note transcribed · ${result.transcript.length} characters`
          : "Voice note had no transcribable speech",
        outcome: speech ? "transcribed" : "no_speech",
        audio_path: data.audio_path,
        audio_duration_ms: result.audioDurationMs,
        transcript: result.transcript,
        session_id: result.sessionId,
      } as Json,
    });
    if (auditError) {
      // A transcript with no record behind it must not be handed over.
      console.error("[voice] voice_transcribe audit insert failed", auditError);
      return { ok: false, reason: "failed", error: VOICE_FAILED_MESSAGE };
    }

    if (!speech) return { ok: false, reason: "no_speech", error: VOICE_NO_SPEECH_MESSAGE };
    return { ok: true, transcript: result.transcript, modelId: result.modelId };
  });
