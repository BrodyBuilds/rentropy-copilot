import { useServerFn } from "@tanstack/react-start";
import { AudioLines, Mic } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import {
  encodeWavMono16,
  isAcceptedAudioFile,
  isApiReadyWav,
  MAX_VOICE_SECONDS,
  readWavInfo,
  VOICE_ACCEPT,
  VOICE_BUCKET,
  VOICE_FAILED_MESSAGE,
  VOICE_SAVE_FAILED_MESSAGE,
  VOICE_TARGET_RATE,
  VOICE_TOO_LONG_MESSAGE,
  VOICE_UNREADABLE_MESSAGE,
  voiceNotePath,
} from "@/lib/copilot-voice";
import { transcribeVoiceNote } from "@/lib/copilot-voice.functions";

class VoiceInputError extends Error {}

/**
 * Turns the picked file into the WAV the transcription API takes. A WAV that is already
 * mono 16-bit PCM at 16/24 kHz is sent as is; anything else (MP3, M4A, other WAVs) is
 * decoded with the Web Audio API and re-encoded as mono 16-bit PCM at 24 kHz.
 */
async function toApiWav(file: File): Promise<Blob> {
  const bytes = await file.arrayBuffer();
  const info = readWavInfo(bytes);
  if (isApiReadyWav(info)) {
    if (info!.durationSeconds > MAX_VOICE_SECONDS) throw new VoiceInputError(VOICE_TOO_LONG_MESSAGE);
    return new Blob([bytes], { type: "audio/wav" });
  }

  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx || typeof OfflineAudioContext === "undefined") throw new VoiceInputError(VOICE_UNREADABLE_MESSAGE);
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    throw new VoiceInputError(VOICE_UNREADABLE_MESSAGE);
  } finally {
    void ctx.close().catch(() => undefined);
  }
  if (decoded.duration > MAX_VOICE_SECONDS) throw new VoiceInputError(VOICE_TOO_LONG_MESSAGE);

  // One output channel: the source's channels are mixed down to mono while resampling.
  const frames = Math.max(1, Math.ceil(decoded.duration * VOICE_TARGET_RATE));
  const offline = new OfflineAudioContext(1, frames, VOICE_TARGET_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return new Blob([encodeWavMono16(rendered.getChannelData(0), VOICE_TARGET_RATE)], { type: "audio/wav" });
}

type Stage = "converting" | "uploading" | "transcribing";
const STAGE_TEXT: Record<Stage, string> = {
  converting: "Preparing the audio…",
  uploading: "Saving the voice note…",
  transcribing: "Transcribing…",
};

/**
 * "Attach tenant voice note" for photo triage. Nothing runs until "Transcribe voice note"
 * is clicked; on success the verbatim transcript is handed to the page's note field.
 */
export function VoiceNoteAttach({
  tenantId,
  disabled,
  onBusyChange,
  onTranscribed,
}: {
  tenantId: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onTranscribed: (transcript: string, modelId: string) => void;
}) {
  const transcribe = useServerFn(transcribeVoiceNote);
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = stage !== null;

  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  function pick(next: File | null) {
    setError(null);
    setNotice(null);
    if (next && !isAcceptedAudioFile(next.name, next.type)) {
      setFile(null);
      setError(VOICE_UNREADABLE_MESSAGE);
      return;
    }
    setFile(next);
  }

  async function run() {
    if (!file || !tenantId) return;
    setError(null);
    setNotice(null);
    try {
      setStage("converting");
      let wav: Blob;
      try {
        wav = await toApiWav(file);
      } catch (e) {
        setError(e instanceof VoiceInputError ? e.message : VOICE_UNREADABLE_MESSAGE);
        return;
      }

      setStage("uploading");
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user.id;
      if (!userId) {
        setError(VOICE_SAVE_FAILED_MESSAGE);
        return;
      }
      const path = voiceNotePath(userId, tenantId, crypto.randomUUID());
      const upload = await supabase.storage
        .from(VOICE_BUCKET)
        .upload(path, wav, { contentType: "audio/wav", upsert: false });
      if (upload.error) {
        console.error("[voice] upload failed", upload.error);
        setError(VOICE_SAVE_FAILED_MESSAGE);
        return;
      }

      setStage("transcribing");
      const result = await transcribe({ data: { tenant_id: tenantId, audio_path: path } });
      if (result.ok) {
        onTranscribed(result.transcript, result.modelId);
      } else if (result.reason === "no_speech") {
        setNotice(result.error);
      } else {
        setError(result.error);
      }
    } catch (e) {
      console.error(e);
      setError(VOICE_FAILED_MESSAGE);
    } finally {
      setStage(null);
    }
  }

  return (
    <div>
      <p className="console-label">Tenant voice note (optional)</p>
      <label className="mt-2 flex cursor-pointer items-center gap-3 rounded-md border border-dashed border-input bg-background px-4 py-4 text-sm text-muted-foreground transition-colors hover:border-primary/60 hover:bg-secondary">
        <Mic className="h-5 w-5" />
        <span className="text-foreground">{file ? file.name : "Attach tenant voice note"}</span>
        <input
          type="file"
          accept={VOICE_ACCEPT}
          className="sr-only"
          aria-label="Tenant voice note"
          disabled={disabled || busy}
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
      </label>
      <p className="mt-1 text-xs text-muted-foreground">MP3, M4A, or WAV, up to 10 minutes.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" onClick={run} disabled={disabled || busy || !file || !tenantId}>
          <AudioLines className="h-4 w-4" />
          {busy ? STAGE_TEXT[stage] : "Transcribe voice note"}
        </Button>
      </div>
      {notice && <p className="mt-3 text-sm text-muted-foreground">{notice}</p>}
      {error && (
        <p className="mt-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
