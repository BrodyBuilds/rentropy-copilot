import { Mic, RotateCcw, Square, Trash2, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { MAX_VOICE_SECONDS } from "@/lib/copilot-voice";

// "Record voice note" (photo triage voice-note add-on). Fenced: it only produces a File
// and hands it to VoiceNoteAttach, which treats it exactly like a picked file (same WAV
// conversion, same upload, transcription only on "Transcribe voice note"). Deleting this
// file and its one use in voice-note-attach.tsx leaves the upload path untouched.

export const MIC_UNAVAILABLE_MESSAGE =
  "Microphone isn't available here — you can upload the voice note as a file instead";
export const RECORDING_CAP_MESSAGE = "Recording stopped at the 10-minute limit.";
export const EMPTY_RECORDING_MESSAGE = "Nothing was recorded — please try again.";

/**
 * Stops just short of 10 minutes so the decoded recording never measures a hair over the
 * same MAX_VOICE_SECONDS cap that uploads are held to.
 */
export const RECORDING_CAP_MS = MAX_VOICE_SECONDS * 1000 - 500;

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];

/** First recording format the browser supports, or "" to let the browser choose. */
export function pickRecordingMimeType(isSupported: (type: string) => boolean): string {
  return MIME_CANDIDATES.find((t) => {
    try {
      return isSupported(t);
    } catch {
      return false;
    }
  }) ?? "";
}

/** m:ss for the elapsed timer. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function extensionFor(type: string): string {
  if (/mp4|m4a|aac/i.test(type)) return "m4a";
  if (/ogg/i.test(type)) return "ogg";
  if (/wav/i.test(type)) return "wav";
  return "webm";
}

type Phase = "idle" | "requesting" | "recording" | "review";
type Take = { blob: Blob; url: string; seconds: number };

export function VoiceNoteRecorder({
  disabled,
  onUse,
}: {
  disabled: boolean;
  onUse: (file: File) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const capRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef(0);
  const capHitRef = useRef(false);
  const mountedRef = useRef(true);
  const takeUrlRef = useRef<string | null>(null);

  function clearTimers() {
    if (tickRef.current) clearInterval(tickRef.current);
    if (capRef.current) clearTimeout(capRef.current);
    tickRef.current = null;
    capRef.current = null;
  }

  function releaseMic() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  function dropTake() {
    if (takeUrlRef.current) URL.revokeObjectURL?.(takeUrlRef.current);
    takeUrlRef.current = null;
    setTake(null);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimers();
      const rec = recorderRef.current;
      if (rec) {
        rec.onstop = null;
        if (rec.state !== "inactive") rec.stop();
      }
      releaseMic();
      if (takeUrlRef.current) URL.revokeObjectURL?.(takeUrlRef.current);
    };
  }, []);

  function finish(type: string) {
    clearTimers();
    releaseMic();
    recorderRef.current = null;
    if (!mountedRef.current) return;
    const seconds = capHitRef.current
      ? MAX_VOICE_SECONDS
      : Math.min(MAX_VOICE_SECONDS, (Date.now() - startedAtRef.current) / 1000);
    const blob = new Blob(chunksRef.current, type ? { type } : undefined);
    chunksRef.current = [];
    if (blob.size === 0) {
      setPhase("idle");
      setMessage(EMPTY_RECORDING_MESSAGE);
      return;
    }
    const url = URL.createObjectURL?.(blob) ?? "";
    takeUrlRef.current = url || null;
    setTake({ blob, url, seconds });
    setElapsed(seconds);
    setPhase("review");
    setMessage(capHitRef.current ? RECORDING_CAP_MESSAGE : null);
  }

  // One click asks for the microphone at most once.
  async function start() {
    if (phase === "requesting" || phase === "recording") return;
    setMessage(null);
    dropTake();
    capHitRef.current = false;

    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!media?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMessage(MIC_UNAVAILABLE_MESSAGE);
      return;
    }

    setPhase("requesting");
    let stream: MediaStream;
    try {
      stream = await media.getUserMedia({ audio: true });
    } catch {
      if (mountedRef.current) {
        setPhase("idle");
        setMessage(MIC_UNAVAILABLE_MESSAGE);
      }
      return;
    }
    if (!mountedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;

    const mimeType = pickRecordingMimeType((t) => MediaRecorder.isTypeSupported?.(t) ?? false);
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      releaseMic();
      setPhase("idle");
      setMessage(MIC_UNAVAILABLE_MESSAGE);
      return;
    }
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => finish(recorder.mimeType || mimeType);
    recorderRef.current = recorder;

    try {
      recorder.start(1000);
    } catch {
      recorder.onstop = null;
      recorderRef.current = null;
      releaseMic();
      setPhase("idle");
      setMessage(MIC_UNAVAILABLE_MESSAGE);
      return;
    }
    startedAtRef.current = Date.now();
    setElapsed(0);
    setPhase("recording");
    tickRef.current = setInterval(() => {
      setElapsed(Math.min(MAX_VOICE_SECONDS, (Date.now() - startedAtRef.current) / 1000));
    }, 250);
    capRef.current = setTimeout(() => {
      capHitRef.current = true;
      stop();
    }, RECORDING_CAP_MS);
  }

  function stop() {
    const rec = recorderRef.current;
    clearTimers();
    if (rec && rec.state !== "inactive") rec.stop();
  }

  function use() {
    if (!take) return;
    const type = take.blob.type || "audio/webm";
    const name = `Recorded voice note (${formatElapsed(take.seconds)}).${extensionFor(type)}`;
    onUse(new File([take.blob], name, { type }));
    dropTake();
    setMessage(null);
    setPhase("idle");
  }

  function discard() {
    dropTake();
    setMessage(null);
    setPhase("idle");
  }

  const recording = phase === "recording";

  return (
    <div className="contents">
      {recording ? (
        <Button type="button" variant="outline" onClick={stop} className="shrink-0">
          <Square className="h-4 w-4" />
          Stop recording
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          onClick={start}
          disabled={disabled || phase === "requesting" || phase === "review"}
          className="shrink-0"
        >
          <Mic className="h-4 w-4" />
          Record voice note
        </Button>
      )}

      {(recording || phase === "review" || message) && (
        <div className="basis-full">
          {recording && (
            <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm font-medium text-foreground">
              <span className="relative flex h-2.5 w-2.5" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
              </span>
              Recording
              <span className="num text-muted-foreground">
                {formatElapsed(elapsed)} / {formatElapsed(MAX_VOICE_SECONDS)}
              </span>
            </p>
          )}

          {phase === "review" && take && (
            <div className="rounded-md border border-border bg-background p-3">
              <p className="console-label">
                Recording · <span className="num">{formatElapsed(take.seconds)}</span>
              </p>
              {take.url && (
                <audio controls src={take.url} className="mt-2 w-full" aria-label="Recorded voice note" />
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={use} disabled={disabled}>
                  <Check className="h-4 w-4" />
                  Use
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={start} disabled={disabled}>
                  <RotateCcw className="h-4 w-4" />
                  Record again
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={discard}>
                  <Trash2 className="h-4 w-4" />
                  Discard
                </Button>
              </div>
            </div>
          )}

          {message && <p className="mt-2 text-sm text-muted-foreground">{message}</p>}
        </div>
      )}
    </div>
  );
}
