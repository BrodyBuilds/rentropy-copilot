import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatElapsed,
  MIC_UNAVAILABLE_MESSAGE,
  pickRecordingMimeType,
  RECORDING_CAP_MESSAGE,
  RECORDING_CAP_MS,
  VoiceNoteRecorder,
} from "./voice-note-recorder";

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = (t: string) => t === "audio/webm";
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? "";
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["sound"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

const trackStop = vi.fn();
function setMic(getUserMedia: (() => Promise<unknown>) | undefined) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: getUserMedia ? { getUserMedia } : undefined,
  });
}

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

beforeEach(() => {
  FakeRecorder.instances = [];
  trackStop.mockReset();
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  URL.createObjectURL = vi.fn(() => "blob:recording");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setMic(undefined);
});

describe("recording helpers", () => {
  it("formats the timer and shows the cap as 10:00", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65.9)).toBe("1:05");
    expect(formatElapsed(600)).toBe("10:00");
  });

  it("stops recordings within the same 10-minute cap as uploads", () => {
    expect(RECORDING_CAP_MS).toBeLessThanOrEqual(600_000);
    expect(RECORDING_CAP_MS).toBeGreaterThan(599_000);
  });

  it("picks the first supported recording format", () => {
    expect(pickRecordingMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickRecordingMimeType(() => false)).toBe("");
  });
});

describe("Record voice note", () => {
  it("shows the plain message and asks only once when permission is denied", async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    setMic(getUserMedia);
    const onUse = vi.fn();
    render(<VoiceNoteRecorder disabled={false} onUse={onUse} />);
    await click("Record voice note");
    expect(screen.getByText(MIC_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(onUse).not.toHaveBeenCalled();
  });

  it("shows the same message when the browser has no microphone access at all", async () => {
    setMic(undefined);
    render(<VoiceNoteRecorder disabled={false} onUse={vi.fn()} />);
    await click("Record voice note");
    expect(screen.getByText(MIC_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
  });

  it("hands the recording over as an attached file only when Use is clicked", async () => {
    const getUserMedia = vi.fn(() => Promise.resolve({ getTracks: () => [{ stop: trackStop }] }));
    setMic(getUserMedia);
    const onUse = vi.fn();
    render(<VoiceNoteRecorder disabled={false} onUse={onUse} />);
    await click("Record voice note");
    expect(screen.getByRole("status")).toHaveTextContent("Recording");
    await click("Stop recording");
    expect(trackStop).toHaveBeenCalled();
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Recorded voice note")).toBeInTheDocument();
    await click("Use");
    expect(onUse).toHaveBeenCalledTimes(1);
    const file = onUse.mock.calls[0]![0] as File;
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe("audio/webm");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("attaches nothing when the recording is discarded", async () => {
    setMic(vi.fn(() => Promise.resolve({ getTracks: () => [{ stop: trackStop }] })));
    const onUse = vi.fn();
    render(<VoiceNoteRecorder disabled={false} onUse={onUse} />);
    await click("Record voice note");
    await click("Stop recording");
    await click("Discard");
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Recorded voice note")).not.toBeInTheDocument();
  });

  it("stops by itself at the 10-minute cap and says so", async () => {
    vi.useFakeTimers();
    setMic(vi.fn(() => Promise.resolve({ getTracks: () => [{ stop: trackStop }] })));
    render(<VoiceNoteRecorder disabled={false} onUse={vi.fn()} />);
    await click("Record voice note");
    expect(FakeRecorder.instances[0]!.state).toBe("recording");
    act(() => {
      vi.advanceTimersByTime(RECORDING_CAP_MS);
    });
    expect(FakeRecorder.instances[0]!.state).toBe("inactive");
    expect(screen.getByText(RECORDING_CAP_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use" })).toBeInTheDocument();
  });
});
