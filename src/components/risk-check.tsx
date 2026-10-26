import { AlertTriangle, Check, Info, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CHECK_LABELS,
  categoryLabel,
  locateFlag,
  type RiskFlag,
  type RiskResult,
  type RiskSeverity,
} from "@/lib/copilot-risk";

export function allFlags(result: RiskResult): RiskFlag[] {
  return [...result.deterministic_flags, ...result.semantic_flags].sort((a, b) => a.start - b.start);
}

export function layersThatRan(result: RiskResult): string[] {
  return result.layers.filter((l) => l.status === "ran").map((l) => CHECK_LABELS[l.check]);
}

const MARK_CLASS: Record<RiskSeverity, string> = {
  high: "bg-destructive/15 text-foreground underline decoration-destructive decoration-2 underline-offset-2",
  medium: "bg-warning text-warning-foreground",
  low: "bg-accent text-accent-foreground",
};

export function SeverityBadge({ severity }: { severity: RiskSeverity }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        severity === "high" && "bg-destructive text-destructive-foreground",
        severity === "medium" && "bg-warning text-warning-foreground",
        severity === "low" && "bg-secondary text-secondary-foreground",
      )}
    >
      {severity}
    </span>
  );
}

/** The current draft text with each locatable flag highlighted and numbered. */
export function HighlightedDraft({
  body,
  result,
  flags,
}: {
  body: string;
  result: RiskResult;
  flags: RiskFlag[];
}) {
  const spans = flags
    .map((flag, i) => ({ flag, n: i + 1, at: locateFlag(flag, body, result.checked_body) }))
    .filter((x): x is { flag: RiskFlag; n: number; at: { start: number; end: number } } => !!x.at)
    .sort((a, b) => a.at.start - b.at.start);

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.at.start < cursor) continue; // overlapping span: shown in its card only
    if (s.at.start > cursor) parts.push(body.slice(cursor, s.at.start));
    parts.push(
      <mark key={s.flag.id} className={cn("rounded-sm px-0.5", MARK_CLASS[s.flag.severity])}>
        {body.slice(s.at.start, s.at.end)}
        <sup className="ml-0.5 font-semibold">{s.n}</sup>
      </mark>,
    );
    cursor = s.at.end;
  }
  if (cursor < body.length) parts.push(body.slice(cursor));

  return (
    <div
      className="whitespace-pre-wrap rounded-md border border-border bg-background p-4 text-sm leading-relaxed text-foreground"
      aria-label="Draft with flagged text highlighted"
    >
      {parts}
    </div>
  );
}

export function FlagCard({
  flag,
  n,
  body,
  result,
  canApply,
  applied,
  onApply,
}: {
  flag: RiskFlag;
  n: number;
  body: string;
  result: RiskResult;
  canApply: boolean;
  applied: boolean;
  onApply: () => void;
}) {
  const located = locateFlag(flag, body, result.checked_body) !== null;
  return (
    <li className="rounded-md border border-border bg-background p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-secondary-foreground">
          {n}
        </span>
        <SeverityBadge severity={flag.severity} />
        <span className="text-sm font-medium text-foreground">{categoryLabel(flag.category)}</span>
        <span className="text-xs text-muted-foreground">
          · {flag.layer === "deterministic" ? `Rule check: ${CHECK_LABELS[flag.check]}` : "AI review"}
        </span>
      </div>
      <blockquote className="mt-3 border-l-2 border-border pl-3 text-sm">
        <mark className={cn("rounded-sm px-0.5", MARK_CLASS[flag.severity])}>{flag.quote}</mark>
      </blockquote>
      <p className="mt-2 text-sm text-foreground">{flag.explanation}</p>
      {flag.expected && (
        <p className="mt-1 text-xs text-muted-foreground">Lease record: {flag.expected}</p>
      )}
      {flag.suggestion !== null && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md bg-secondary px-3 py-2">
          <p className="text-sm text-secondary-foreground">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Suggested: </span>“
            {flag.suggestion}”
          </p>
          {applied ? (
            <span className="flex items-center gap-1 text-xs font-medium text-success-foreground">
              <Check className="h-3.5 w-3.5" /> Applied
            </span>
          ) : canApply && located ? (
            <Button size="sm" variant="outline" onClick={onApply}>
              Apply
            </Button>
          ) : null}
        </div>
      )}
      {!located && !applied && (
        <p className="mt-2 text-xs text-muted-foreground">
          This text no longer appears exactly once in the draft.
        </p>
      )}
    </li>
  );
}

export function NeutralNote({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex gap-3 rounded-md border border-border bg-secondary/60 px-4 py-3">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export function WarningBanner({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning-foreground/30 bg-warning px-4 py-3 text-sm font-medium text-warning-foreground">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function CleanRun({ result }: { result: RiskResult }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-success px-4 py-3 text-sm text-success-foreground">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        <span className="font-medium">No flags from the checks that ran:</span>{" "}
        {layersThatRan(result).join(", ")}.
      </span>
    </div>
  );
}
