import { describe, expect, it } from "vitest";

import { parseSegmentationText, readResponsesText, StreamError } from "./copilot-segmentation";

describe("parseSegmentationText", () => {
  it("reads named box tokens with confidence and ignores mask data", () => {
    const text = "box x1=10 y1=20 x2=110 y2=220 w=640 h=480 c=0.91 mask=AbCboxQ+/9== box x1=300 y1=40 x2=360 y2=90 w=640 h=480 mask=Zz==";
    const { boxes, unparsed } = parseSegmentationText(text);
    expect(unparsed).toBe(0);
    expect(boxes).toEqual([
      { frame: 0, x1: 10, y1: 20, x2: 110, y2: 220, w: 640, h: 480, c: 0.91 },
      { frame: 0, x1: 300, y1: 40, x2: 360, y2: 90, w: 640, h: 480, c: null },
    ]);
  });

  it("reads positional box tokens as x1 y1 x2 y2 w h c", () => {
    const { boxes } = parseSegmentationText("<box 5 6 50 60 100 100 0.5><mask 1011>");
    expect(boxes).toEqual([{ frame: 0, x1: 5, y1: 6, x2: 50, y2: 60, w: 100, h: 100, c: 0.5 }]);
  });

  it("reads JSON-style records", () => {
    const { boxes } = parseSegmentationText('{"box": {"x1": 1, "y1": 2, "x2": 3, "y2": 4, "w": 10, "h": 10, "c": 0.7}, "mask": "QQ=="}');
    expect(boxes[0]).toMatchObject({ x1: 1, y1: 2, x2: 3, y2: 4, c: 0.7 });
  });

  it("uses one line per frame, so a photo's records are frame 0", () => {
    const { boxes } = parseSegmentationText("box 0 0 5 5 10 10\nbox 1 1 6 6 10 10");
    expect(boxes.map((b) => b.frame)).toEqual([0, 1]);
  });

  it("counts boxes that are incomplete or inverted instead of inventing them", () => {
    const { boxes, unparsed } = parseSegmentationText("box x1=10 y1=10 w=100 h=100 mask=A box 50 50 10 10 100 100");
    expect(boxes).toEqual([]);
    expect(unparsed).toBe(2);
  });

  it("returns nothing for an empty reply", () => {
    expect(parseSegmentationText("")).toEqual({ boxes: [], unparsed: 0 });
  });
});

describe("readResponsesText", () => {
  it("joins streamed output_text deltas", () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"box 0 0 "}',
      'data: {"type":"response.output_text.delta","delta":"5 5 10 10"}',
      "data: [DONE]",
    ].join("\n");
    expect(readResponsesText(sse)).toBe("box 0 0 5 5 10 10");
  });

  it("prefers the done event's full text", () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"partial"}',
      'data: {"type":"response.output_text.done","text":"full text"}',
    ].join("\n");
    expect(readResponsesText(sse)).toBe("full text");
  });

  it("throws when the stream reports a failure", () => {
    expect(() => readResponsesText('data: {"type":"response.failed"}')).toThrow(StreamError);
  });

  it("falls back to a plain JSON body", () => {
    expect(readResponsesText(JSON.stringify({ output_text: "box 1 1 2 2 4 4" }))).toBe("box 1 1 2 2 4 4");
  });
});
