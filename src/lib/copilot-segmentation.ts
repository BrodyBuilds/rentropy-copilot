// Pure, client-safe parsing for SAM segmentation replies (no network, no env).
//
// The reply's output text carries one line per frame (a photo is frame 0).
// Each record on a line holds a `box` token with x1, y1, x2, y2, w, h and an
// optional c confidence, plus a `mask` token with encoded data. Masks are kept
// only inside the raw text; boxes and confidences are parsed out here.

export type SegmentationBox = {
  frame: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Width and height of the frame the box coordinates are measured against. */
  w: number;
  h: number;
  /** Confidence 0..1, or null when the record had none. */
  c: number | null;
};

export type ParsedSegmentation = {
  boxes: SegmentationBox[];
  /** box tokens that could not be read as a complete, valid box. */
  unparsed: number;
};

const NUM = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const NAMED_RE = new RegExp(String.raw`["']?\b(x1|y1|x2|y2|w|h|c)\b["']?\s*[=:]\s*(${NUM})`, "gi");
const NUMBER_RE = new RegExp(NUM, "g");
// A token keyword only counts at the start of the line or after a delimiter, so
// "box"/"mask" letter runs inside encoded mask data are never mistaken for tokens.
const TOKEN_RE = /(^|[\s;|,{[(<"'])(box|mask)\b/gi;
const FRAME_PREFIX_RE = /^\s*(?:frame\s*)?(\d+)\s*[:|\-)\]]/i;

function toBox(frame: number, segment: string): SegmentationBox | null {
  const named: Record<string, number> = {};
  for (const m of segment.matchAll(NAMED_RE)) {
    const key = m[1]?.toLowerCase();
    const value = Number(m[2]);
    if (key && Number.isFinite(value) && !(key in named)) named[key] = value;
  }

  let vals: Partial<Record<"x1" | "y1" | "x2" | "y2" | "w" | "h" | "c", number | undefined>>;
  if (["x1", "y1", "x2", "y2", "w", "h"].every((k) => k in named)) {
    vals = named;
  } else {
    // Positional form: x1 y1 x2 y2 w h [c]
    const nums = (segment.match(NUMBER_RE) ?? []).map(Number);
    if (nums.length < 6) return null;
    const [x1, y1, x2, y2, w, h, c] = nums;
    vals = { x1, y1, x2, y2, w, h, c };
  }

  const { x1, y1, x2, y2, w, h } = vals;
  if ([x1, y1, x2, y2, w, h].some((v) => v === undefined || !Number.isFinite(v))) return null;
  if (w! <= 0 || h! <= 0 || x2! <= x1! || y2! <= y1!) return null;
  const c = vals.c;
  return {
    frame,
    x1: x1!,
    y1: y1!,
    x2: x2!,
    y2: y2!,
    w: w!,
    h: h!,
    c: c !== undefined && Number.isFinite(c) && c >= 0 && c <= 1 ? c : null,
  };
}

/** Parses the boxes out of SAM's output text using the frame/box/mask grammar. */
export function parseSegmentationText(text: string): ParsedSegmentation {
  const boxes: SegmentationBox[] = [];
  let unparsed = 0;
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");

  lines.forEach((line, index) => {
    const prefix = FRAME_PREFIX_RE.exec(line);
    const frame = prefix ? Number(prefix[1]) : index;

    const tokens = [...line.matchAll(TOKEN_RE)].map((m) => ({
      kind: (m[2] ?? "").toLowerCase(),
      start: (m.index ?? 0) + (m[1]?.length ?? 0),
      end: (m.index ?? 0) + m[0].length,
    }));
    tokens.forEach((token, i) => {
      if (token.kind !== "box") return;
      const next = tokens[i + 1];
      const segment = line.slice(token.end, next ? next.start : line.length);
      const box = toBox(frame, segment);
      if (box) boxes.push(box);
      else unparsed += 1;
    });
  });

  return { boxes, unparsed };
}

type ResponsesOutput = {
  output_text?: unknown;
  output?: Array<{ content?: Array<{ type?: string; text?: unknown }> }>;
};

function textFromResponseObject(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const r = obj as ResponsesOutput;
  if (typeof r.output_text === "string") return r.output_text;
  return (r.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

export class StreamError extends Error {}

/**
 * Reads the output text from a /responses reply: a server-sent-event stream
 * (delta / done / completed events) or, as a fallback, a plain JSON body.
 * Throws StreamError when the stream reports a failure.
 */
export function readResponsesText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      return textFromResponseObject(JSON.parse(trimmed)).trim();
    } catch {
      // fall through to SSE parsing
    }
  }

  let deltas = "";
  const done: string[] = [];
  let completed = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event: { type?: string; delta?: unknown; text?: unknown; response?: unknown; error?: unknown };
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    switch (event.type) {
      case "response.output_text.delta":
        if (typeof event.delta === "string") deltas += event.delta;
        break;
      case "response.output_text.done":
        if (typeof event.text === "string") done.push(event.text);
        break;
      case "response.completed":
        completed = textFromResponseObject(event.response);
        break;
      case "response.failed":
      case "response.error":
      case "error":
        throw new StreamError("Segmentation stream reported an error");
    }
  }
  const text = done.length ? done.join("\n") : deltas || completed;
  return text.trim();
}
