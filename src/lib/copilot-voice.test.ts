import { describe, expect, it } from "vitest";

import {
  encodeWavMono16,
  hasSpeech,
  isAcceptedAudioFile,
  isApiReadyWav,
  isOwnVoiceNotePath,
  readWavInfo,
  voiceNotePath,
} from "./copilot-voice";

const USER = "11111111-1111-4111-8111-111111111111";
const TENANT = "00000000-0000-4000-8000-000000000002";
const FILE = "44444444-4444-4444-8444-444444444444";

describe("voice note WAV conversion output", () => {
  it("encodes mono 16-bit PCM at 24 kHz that the transcription API accepts", () => {
    const samples = new Float32Array(24_000 * 2); // 2 seconds
    const info = readWavInfo(encodeWavMono16(samples, 24_000));
    expect(info).toMatchObject({ format: 1, channels: 1, sampleRate: 24_000, bitsPerSample: 16 });
    expect(info!.durationSeconds).toBe(2);
    expect(isApiReadyWav(info)).toBe(true);
  });

  it("does not pass a 22.05 kHz or stereo WAV through unconverted", () => {
    expect(isApiReadyWav(readWavInfo(encodeWavMono16(new Float32Array(10), 22_050)))).toBe(false);
    const stereo = readWavInfo(encodeWavMono16(new Float32Array(10), 24_000))!;
    expect(isApiReadyWav({ ...stereo, channels: 2 })).toBe(false);
  });

  it("is not a WAV when the bytes are not RIFF/WAVE", () => {
    expect(readWavInfo(new TextEncoder().encode("ID3 not a wav file at all"))).toBeNull();
  });
});

describe("voice note files and paths", () => {
  it("accepts mp3, m4a and wav only", () => {
    expect(isAcceptedAudioFile("note.mp3", "")).toBe(true);
    expect(isAcceptedAudioFile("note.M4A", "")).toBe(true);
    expect(isAcceptedAudioFile("note.wav", "")).toBe(true);
    expect(isAcceptedAudioFile("note.ogg", "audio/ogg")).toBe(false);
  });

  it("only accepts a path in the uploader's own folder for this tenant", () => {
    const path = voiceNotePath(USER, TENANT, FILE);
    expect(isOwnVoiceNotePath(path, USER, TENANT)).toBe(true);
    expect(isOwnVoiceNotePath(path, "99999999-9999-4999-8999-999999999999", TENANT)).toBe(false);
    expect(isOwnVoiceNotePath(path, USER, "00000000-0000-4000-8000-000000000001")).toBe(false);
    expect(isOwnVoiceNotePath(`${USER}/${TENANT}/../x.wav`, USER, TENANT)).toBe(false);
  });

  it("treats a blank transcript as no speech", () => {
    expect(hasSpeech("")).toBe(false);
    expect(hasSpeech("  \n")).toBe(false);
    expect(hasSpeech("It's dripping.")).toBe(true);
  });
});
