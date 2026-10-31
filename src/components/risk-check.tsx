import { AlertTriangle, Check, Info, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  CHECK_LABELS,
  categoryLabel,
  locateFlag,
  type RiskFlag,
  type RiskSeverity,
} from "@/lib/copilot-risk";
import type { StoredRiskResult } from "@/lib/copilot.functions";

/** Anything the review UI renders; results stored before `status` existed have none. */
type ReviewResult = Omit<StoredRiskResult, "status"> & { status?: StoredRiskResult["status"] };

export const PARTIAL_BANNER_TEXT = "Language review did not run - manual review required";
export const PARTIAL_ACK_TEXT =
  "I understand the rule checks ran but the language review could not run, and I have reviewed this draft myself";

/** True only when the stored result says it is partial. */
export function isPartialResult(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { status?: unknown }).status === "partial"
  );
}

/**
 * Reads a stored risk result. Results saved before `status` existed were always full
 * checks (a failed check used to clear the field), so they read as "complete".
 */
export function readStoredRisk(value: unknown): StoredRiskResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Partial<StoredRiskResult>;
  if (v.version !== 1 || typeof v.checked_body !== "string") return null;
  return { ...(v as StoredRiskResult), status: isPartialResult(v) ? "partial" : "complete" };
}

/**
 * The approve gate. A partial result needs its own acknowledgment before Approve is
 * clickable; high-severity flags still need the separate "Approve anyway" click.
 */
export function approvalGate(args: {
  partial: boolean;
  partialAcknowledged: boolean;
  highCount: number;
  highConfirmed: boolean;
}): { approveEnabled: boolean; needsHighConfirm: boolean } {
  return {
    approveEnabled: !args.partial || args.partialAcknowledged,
    needsHighConfirm: args.highCount > 0 && !args.highConfirmed,
  };
}

export function allFlags(result: ReviewResult): RiskFlag[] {
  return [...result.deterministic_flags, ...result.semantic_flags].sort((a, b) => a.start - b.start);
}

export function layersThatRan(result: ReviewResult): string[] {
  return result.layers.filter((l) => l.status === "ran").map((l) => CHECK_LABELS[l.check]);
}

const MARK_CLASS: Record<RiskSeverity, string> = {
  high: "bg-destructive/30 font-semibold text-foreground underline decoration-destructive decoration-[3px] underline-offset-[3px] ring-1 ring-destructive",
  medium: "bg-warning font-medium text-warning-foreground ring-1 ring-warning-foreground/60",
  low: "bg-accent text-accent-foreground ring-1 ring-accent-foreground/30",
};

export function SeverityBadge({ severity }: { severity: RiskSeverity }) {
  return (
    <span
      className={cn(
        "num inline-flex items-center rounded-sm px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.14em]",
        severity === "high" && "glow-destructive bg-destructive text-destructive-foreground",
        severity === "medium" && "border border-warning-foreground/60 bg-warning text-warning-foreground",
        severity === "low" && "border border-border bg-secondary text-secondary-foreground",
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
  result: ReviewResult;
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
        <sup className="num ml-0.5 font-bold">{s.n}</sup>
      </mark>,
    );
    cursor = s.at.end;
  }
  if (cursor < body.length) parts.push(body.slice(cursor));

  return (
    <div
      className="whitespace-pre-wrap rounded-md border border-border bg-background p-4 text-[15px] leading-7 text-foreground"
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
  result: ReviewResult;
  canApply: boolean;
  applied: boolean;
  onApply: () => void;
}) {
  const located = locateFlag(flag, body, result.checked_body) !== null;
  return (
    <li
      className={cn(
        "rounded-md border border-l-4 border-border bg-background p-4",
        flag.severity === "high" && "border-l-destructive",
        flag.severity === "medium" && "border-l-warning-foreground",
        flag.severity === "low" && "border-l-accent-foreground/50",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="num flex h-5 w-5 items-center justify-center rounded-sm bg-secondary text-[11px] font-bold text-secondary-foreground">
          {n}
        </span>
        <SeverityBadge severity={flag.severity} />
        <span className="text-sm font-semibold text-foreground">{categoryLabel(flag.category)}</span>
        <span className="num text-[11px] text-muted-foreground">
          · {flag.layer === "deterministic" ? `Rule check: ${CHECK_LABELS[flag.check]}` : "AI review"}
        </span>
      </div>
      <blockquote className="mt-3 pl-1 text-[15px] leading-7">
        <mark className={cn("rounded-sm px-0.5", MARK_CLASS[flag.severity])}>{flag.quote}</mark>
      </blockquote>
      <p className="mt-2 text-sm text-foreground">{flag.explanation}</p>
      {flag.expected && (
        <p className="mt-2 text-xs text-muted-foreground">
          Lease record: <span className="num text-sm font-semibold text-foreground">{flag.expected}</span>
        </p>
      )}
      {flag.suggestion !== null && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-secondary px-3 py-2">
          <p className="text-sm text-secondary-foreground">
            <span className="console-label">Suggested: </span>“
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
    <div className="flex gap-3 rounded-md border border-dashed border-border bg-secondary/50 px-4 py-3">
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
    <div className="flex items-start gap-2 rounded-md border border-warning-foreground/50 bg-warning px-4 py-3 text-sm font-semibold text-warning-foreground">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function CleanRun({ result }: { result: ReviewResult }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-success-foreground/30 bg-success px-4 py-3 text-sm text-success-foreground">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        <span className="font-medium">No flags from the checks that ran:</span>{" "}
        {layersThatRan(result).join(", ")}.
      </span>
    </div>
  );
}

export function IncompleteBadge() {
  return (
    <span className="num rounded-sm border border-warning-foreground/60 bg-warning px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.14em] text-warning-foreground">
      Incomplete
    </span>
  );
}

/** The separate acknowledgment a partial result needs before Approve enables. */
export function PartialAcknowledgment({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-md border border-warning-foreground/50 bg-warning px-3 py-2.5 text-sm text-warning-foreground">
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        disabled={disabled}
        className="mt-0.5 border-warning-foreground"
      />
      <span>{PARTIAL_ACK_TEXT}</span>
    </label>
  );
}

function FlagList({
  flags,
  body,
  result,
  canApply,
  appliedIds,
  onApply,
}: {
  flags: RiskFlag[];
  body: string;
  result: ReviewResult;
  canApply: boolean;
  appliedIds: Set<string>;
  onApply: (flag: RiskFlag) => void;
}) {
  return (
    <>
      <HighlightedDraft body={body} result={result} flags={flags} />
      <ol className="space-y-3">
        {flags.map((f, i) => (
          <FlagCard
            key={f.id}
            flag={f}
            n={i + 1}
            body={body}
            result={result}
            canApply={canApply}
            applied={appliedIds.has(f.id)}
            onApply={() => onApply(f)}
          />
        ))}
      </ol>
    </>
  );
}

/** Everything shown under "Risk check" once a result exists. Branches on the stored status. */
export function RiskResults({
  risk,
  body,
  isPending,
  appliedIds,
  onApply,
  onRetry,
  retryDisabled,
  checking,
}: {
  risk: ReviewResult;
  body: string;
  isPending: boolean;
  appliedIds: Set<string>;
  onApply: (flag: RiskFlag) => void;
  onRetry: () => void;
  retryDisabled: boolean;
  checking: boolean;
}) {
  const flags = allFlags(risk);
  const stale = body !== risk.checked_body;
  const notDeterminableLayers = risk.layers
    .filter((l) => l.status === "not_determinable")
    .map((l) => CHECK_LABELS[l.check]);

  if (risk.status === "partial") {
    const ruleFlags = flags.filter((f) => f.layer === "deterministic");
    const languageNote = risk.info.find((i) => i.check === "semantic");
    return (
      <>
        <div className="space-y-3 rounded-md border border-l-4 border-warning-foreground/60 border-l-warning-foreground bg-warning p-4 text-warning-foreground">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <IncompleteBadge />
            {isPending && (
              <Button size="sm" onClick={onRetry} disabled={retryDisabled}>
                {checking ? "Checking…" : "Retry language review"}
              </Button>
            )}
          </div>
          <p className="flex items-start gap-2 text-sm font-medium" role="alert">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {PARTIAL_BANNER_TEXT}
          </p>
        </div>
        {stale && (
          <WarningBanner>Draft changed since the check — run the risk check again</WarningBanner>
        )}

        <div className="space-y-3">
          <h4 className="console-label">
            Rule checks
          </h4>
          {ruleFlags.length === 0 ? (
            <p className="text-sm text-foreground">
              The rule checks found nothing to flag. This is not a full check — read the draft yourself.
            </p>
          ) : (
            <FlagList
              flags={ruleFlags}
              body={body}
              result={risk}
              canApply={isPending}
              appliedIds={appliedIds}
              onApply={onApply}
            />
          )}
          {risk.not_determinable.map((nd) => (
            <NeutralNote key={nd.check} title={nd.title} detail={nd.detail} />
          ))}
          {risk.info
            .filter((i) => i.check !== "semantic")
            .map((info) => (
              <NeutralNote key={info.check} title={info.title} detail={info.detail} />
            ))}
        </div>

        <div className="space-y-2">
          <h4 className="console-label flex items-center gap-2">
            Language review
            <span className="rounded-sm border border-warning-foreground/60 bg-warning px-2 py-0.5 font-bold text-warning-foreground">
              Not run
            </span>
          </h4>
          {languageNote && <p className="text-sm text-muted-foreground">{languageNote.detail}</p>}
        </div>

        <p className="text-xs text-muted-foreground">
          Checks that ran: {layersThatRan(risk).join(", ")}. Not run: {CHECK_LABELS.semantic}.
          {notDeterminableLayers.length > 0 &&
            ` Not determinable: ${notDeterminableLayers.join(", ")}.`}{" "}
          The check informs; you decide.
        </p>
      </>
    );
  }

  return (
    <>
      {stale && (
        <WarningBanner>Draft changed since the check — run the risk check again</WarningBanner>
      )}
      {flags.length === 0 ? (
        <CleanRun result={risk} />
      ) : (
        <FlagList
          flags={flags}
          body={body}
          result={risk}
          canApply={isPending}
          appliedIds={appliedIds}
          onApply={onApply}
        />
      )}
      {risk.not_determinable.map((nd) => (
        <NeutralNote key={nd.check} title={nd.title} detail={nd.detail} />
      ))}
      {risk.info.map((info) => (
        <NeutralNote key={info.check} title={info.title} detail={info.detail} />
      ))}
      <p className="text-xs text-muted-foreground">
        Checks that ran: {layersThatRan(risk).join(", ")}.
        {notDeterminableLayers.length > 0 && ` Not determinable: ${notDeterminableLayers.join(", ")}.`}
        {risk.rejected_quote_count > 0 &&
          ` ${risk.rejected_quote_count} AI flag${risk.rejected_quote_count === 1 ? " was" : "s were"} dropped because the quoted text didn't match the draft exactly once.`}
        {" "}The check informs; you decide.
      </p>
    </>
  );
}
