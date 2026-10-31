// Tenant voice notes (photo triage add-on). Client-safe, pure helpers shared by the
// attach control and the transcription server function: WAV reading/writing, the
// owner-scoped storage path, and the user-facing messages. No data access here.
// Self-contained: deleting this file, copilot-voice.functions.ts and
// src/components/voice-note-attach.tsx (plus its one use on the triage page) removes it.

export const VOICE_BUCKET = "tenant-voice-notes";
/** Longest voice note accepted (the transcription API's own cap). */
export const MAX_VOICE_SECONDS = 600;
/** The transcription model's native rate; non-WAV files are converted to this. */
export const VOICE_TARGET_RATE = 24_000;
/** Request cap on the transcription API is 32 MB; 10 min at 24 kHz is ~28.8 MB. */
export const MAX_VOICE_BYTES = 31 * 1024 * 1024;

export const VOICE_FAILED_MESSAGE = "Couldn't transcribe that audio just now — please try again.";
export const VOICE_NO_SPEECH_MESSAGE = "No speech could be transcribed from that file.";
export const VOICE_TOO_LONG_MESSAGE = "That voice note is longer than 10 minutes. Please use a shorter recording.";
export const VOICE_UNREADABLE_MESSAGE = "That audio file couldn't be read. Please use an MP3, M4A, or WAV file.";
export const VOICE_SAVE_FAILED_MESSAGE = "The voice note couldn't be saved. Please try again.";

export const VOICE_ACCEPT = ".mp3,.m4a,.wav,audio/mpeg,audio/mp3,audio/mp4,audio/x-m4a,audio/m4a,audio/aac,audio/wav,audio/x-wav,audio/wave";

/** MP3, M4A or WAV, by extension or MIME type. */
export function isAcceptedAudioFile(name: string, type: string): boolean {
  if (/\.(mp3|m4a|wav)$/i.test(name)) return true;
  return /^audio\/(mpeg|mp3|mp4|x-m4a|m4a|aac|wav|x-wav|wave)$/i.test(type);
}

export type WavInfo = {
  /** 1 = integer PCM. */
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  durationSeconds: number;
};

/** Reads a RIFF/WAVE header; null when the bytes are not a WAV file. */
export function readWavInfo(input: ArrayBuffer | Uint8Array): WavInfo | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let fmt: Omit<WavInfo, "dataBytes" | "durationSeconds"> | null = null;
  let dataBytes: number | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= bytes.length) {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      dataBytes = Math.min(size, bytes.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || dataBytes === null) return null;
  const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  return { ...fmt, dataBytes, durationSeconds: bytesPerSecond > 0 ? dataBytes / bytesPerSecond : 0 };
}

/** True when the WAV is already what the transcription API takes: mono 16-bit PCM at 16 or 24 kHz. */
export function isApiReadyWav(info: WavInfo | null): boolean {
  return (
    !!info &&
    info.format === 1 &&
    info.channels === 1 &&
    info.bitsPerSample === 16 &&
    (info.sampleRate === 16_000 || info.sampleRate === 24_000)
  );
}

/** Encodes mono float samples (-1..1) as a 16-bit PCM WAV file. */
export function encodeWavMono16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeTag = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  writeTag(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeTag(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return buffer;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Storage path: the uploader's own user-id folder (the bucket rules require it), then the tenant. */
export function voiceNotePath(userId: string, tenantId: string, fileId: string): string {
  return `${userId}/${tenantId}/${fileId}.wav`;
}

/** True only for a path in this user's folder, for this tenant, in the shape voiceNotePath makes. */
export function isOwnVoiceNotePath(path: string, userId: string, tenantId: string): boolean {
  const prefix = `${userId}/${tenantId}/`;
  return path.startsWith(prefix) && new RegExp(`^${UUID}\\.wav$`, "i").test(path.slice(prefix.length));
}

/** A transcript with nothing but whitespace means the file had no transcribable speech. */
export function hasSpeech(transcript: string): boolean {
  return transcript.trim().length > 0;
}
