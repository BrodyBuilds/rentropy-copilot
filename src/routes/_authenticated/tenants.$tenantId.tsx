import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, ArrowLeft, Copy, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  PartialAcknowledgment,
  RiskResults,
  WarningBanner,
  allFlags,
  approvalGate,
  isPartialResult,
  readStoredRisk,
} from "@/components/risk-check";
import { TenantQaPanel } from "@/components/tenant-qa-panel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  copilotDraft,
  decideDraft,
  getDraft,
  getTenant,
  runRiskCheck,
  RISK_CHECK_FAILED_MESSAGE,
  type DraftRow,
  type StoredRiskResult,
} from "@/lib/copilot.functions";
import type { Json } from "@/integrations/supabase/types";
import { applySuggestion, type RiskFlag } from "@/lib/copilot-risk";
import {
  DEFAULT_DRAFT_LANGUAGE,
  DRAFT_LANGUAGES,
  MESSAGE_TYPES,
  TONES,
  buildFacts,
  draftHeading,
  formatCents,
  formatDate,
  type DraftLanguage,
  type Fact,
  type MessageType,
  type Tone,
} from "@/lib/copilot-shared";

const tenantQuery = (tenantId: string) =>
  queryOptions({
    queryKey: ["tenant", tenantId],
    queryFn: () => getTenant({ data: { tenantId } }),
  });

export const Route = createFileRoute("/_authenticated/tenants/$tenantId")({
  // Optional: open an existing draft (e.g. the tenant reply a photo triage created).
  validateSearch: (search: Record<string, unknown>): { draft?: string } =>
    typeof search["draft"] === "string" ? { draft: search["draft"] } : {},
  head: () => ({
    meta: [
      { title: "Draft a message — Rentropy Copilot" },
      { name: "description", content: "Draft, review, and approve a message to a tenant." },
      { property: "og:title", content: "Draft a message — Rentropy Copilot" },
      { property: "og:description", content: "Draft, review, and approve a message to a tenant." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: async ({ context, params }) => {
    const tenant = await context.queryClient.ensureQueryData(tenantQuery(params.tenantId));
    if (!tenant) throw notFound();
  },
  component: ComposePage,
  notFoundComponent: () => (
    <div className="text-center">
      <p className="text-muted-foreground">That tenant doesn't exist.</p>
      <Link to="/tenants" className="mt-4 inline-block text-sm text-primary underline">
        Back to tenants
      </Link>
    </div>
  ),
});

function ComposePage() {
  const { tenantId } = Route.useParams();
  const { data: tenant } = useSuspenseQuery(tenantQuery(tenantId));
  const generate = useServerFn(copilotDraft);
  const decide = useServerFn(decideDraft);
  const riskCheck = useServerFn(runRiskCheck);

  const [messageType, setMessageType] = useState<MessageType>("late_rent");
  const [tone, setTone] = useState<Tone>("firm_but_fair");
  const [language, setLanguage] = useState<DraftLanguage>(DEFAULT_DRAFT_LANGUAGE);
  // Language of the draft on screen (may differ from the picker until a new draft is written).
  const [draftLanguage, setDraftLanguage] = useState<DraftLanguage>(DEFAULT_DRAFT_LANGUAGE);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftRow | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [body, setBody] = useState("");
  const [deciding, setDeciding] = useState<"approve" | "discard" | null>(null);
  const [risk, setRisk] = useState<StoredRiskResult | null>(null);
  const [riskError, setRiskError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  const [confirmHigh, setConfirmHigh] = useState(false);
  const [partialAck, setPartialAck] = useState(false);

  const { draft: draftParam } = Route.useSearch();
  const linkedDraft = useQuery({
    queryKey: ["draft", draftParam],
    queryFn: () => getDraft({ data: { draftId: draftParam ?? "" } }),
    enabled: !!draftParam,
  });
  const [seededFor, setSeededFor] = useState<string | null>(null);
  useEffect(() => {
    const d = linkedDraft.data;
    if (!tenant || !d || d.tenant_id !== tenant.id || seededFor === d.id) return;
    setSeededFor(d.id);
    const type = MESSAGE_TYPES.find((m) => m.value === d.message_type)?.value;
    const savedTone = TONES.find((t) => t.value === d.tone)?.value;
    if (type) setMessageType(type);
    if (savedTone) setTone(savedTone);
    setLanguage(d.language);
    setDraftLanguage(d.language);
    setDraft(d);
    setBody(d.draft_body);
    setFacts(type ? buildFacts(tenant, type) : []);
    setRisk(d.risk_checked_at ? readStoredRisk(d.risk_flags) : null);
    setRiskError(null);
    setAppliedIds(new Set());
    setConfirmHigh(false);
    setPartialAck(false);
  }, [linkedDraft.data, tenant, seededFor]);

  if (!tenant) return null;

  async function runDraft() {
    setDrafting(true);
    setError(null);
    try {
      const result = await generate({
        data: { tenant_id: tenantId, message_type: messageType, tone, language },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDraft(result.draft);
      setDraftLanguage(result.language);
      setFacts(result.facts);
      setBody(result.draft.draft_body);
      resetRisk();
    } catch (e) {
      console.error(e);
      setError("Something went wrong. Please try again.");
    } finally {
      setDrafting(false);
    }
  }

  function resetRisk() {
    setRisk(null);
    setRiskError(null);
    setAppliedIds(new Set());
    setConfirmHigh(false);
    setPartialAck(false);
  }

  function updateBody(next: string) {
    setBody(next);
    setConfirmHigh(false);
  }

  async function runRisk() {
    if (!draft) return;
    setChecking(true);
    setConfirmHigh(false);
    setPartialAck(false);
    try {
      const res = await riskCheck({ data: { draft_id: draft.id, draft_body: body } });
      if (!res.ok) {
        setRisk(null);
        setRiskError(res.error);
        setDraft({ ...draft, risk_flags: null, risk_checked_at: null });
        return;
      }
      setRisk(res.result);
      setRiskError(null);
      setAppliedIds(new Set());
      setDraft({
        ...draft,
        risk_flags: res.result as unknown as Json,
        risk_checked_at: res.riskCheckedAt,
      });
    } catch (e) {
      console.error(e);
      setRisk(null);
      setRiskError(RISK_CHECK_FAILED_MESSAGE);
    } finally {
      setChecking(false);
    }
  }

  function applyFlag(flag: RiskFlag) {
    if (!risk) return;
    const next = applySuggestion(flag, body, risk.checked_body);
    if (next === null) return;
    updateBody(next);
    setAppliedIds((prev) => new Set(prev).add(flag.id));
  }

  async function runDecision(decision: "approve" | "discard") {
    if (!draft) return;
    if (decision === "approve") {
      if (!gate.approveEnabled) return;
      if (gate.needsHighConfirm) {
        setConfirmHigh(true);
        return;
      }
    }
    setDeciding(decision);
    try {
      const updated = await decide({
        data: {
          draft_id: draft.id,
          decision,
          ...(decision === "approve" ? { draft_body: body } : {}),
          ...(decision === "approve" && partial ? { partial_review_acknowledged: partialAck } : {}),
        },
      });
      setDraft(updated);
      setBody(updated.draft_body);
      setConfirmHigh(false);
      setPartialAck(false);
      toast.success(decision === "approve" ? "Draft approved" : "Draft discarded");
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : "Couldn't update the draft");
    } finally {
      setDeciding(null);
    }
  }

  function startOver() {
    setDraft(null);
    setFacts([]);
    setBody("");
    setError(null);
    resetRisk();
  }

  async function copyDraft() {
    await navigator.clipboard.writeText(body);
    toast.success("Copied to clipboard");
  }

  const isPending = draft?.status === "pending";
  const flags = risk ? allFlags(risk) : [];
  const highCount = flags.filter((f) => f.severity === "high").length;
  const stale = risk !== null && body !== risk.checked_body;
  const neverChecked = !risk && !riskError && !draft?.risk_checked_at;
  // Branch on the stored status only: a partial is never a pass, whatever its flag count.
  const partial = risk?.status === "partial" || isPartialResult(draft?.risk_flags);
  const gate = approvalGate({
    partial,
    partialAcknowledged: partialAck,
    highCount,
    highConfirmed: confirmHigh,
  });

  return (
    <div>
      <Link
        to="/tenants"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Tenants
      </Link>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-foreground">{tenant.full_name}</h1>
          <p className="text-sm text-muted-foreground">
            {tenant.property_label} · Lease {formatDate(tenant.lease_start)} –{" "}
            {formatDate(tenant.lease_end)}
          </p>
        </div>
        <div className="flex gap-6 text-sm">
          <Stat label="Rent" value={formatCents(tenant.rent_cents)} />
          <Stat label="Balance" value={formatCents(tenant.balance_cents)} />
          <Stat label="Deposit" value={tenant.deposit_status} />
        </div>
      </div>

      <section className="mt-8 rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
          <ChoiceRow
            label="Message type"
            options={MESSAGE_TYPES}
            value={messageType}
            onChange={setMessageType}
            disabled={drafting || isPending}
          />
          <ChoiceRow
            label="Draft language"
            options={DRAFT_LANGUAGES}
            value={language}
            onChange={setLanguage}
            disabled={drafting || isPending}
          />
        </div>
        <div className="mt-4">
          <ChoiceRow
            label="Tone"
            options={TONES}
            value={tone}
            onChange={setTone}
            disabled={drafting || isPending}
          />
        </div>
        <div className="mt-5 flex items-center gap-3">
          <Button onClick={runDraft} disabled={drafting || isPending}>
            <Sparkles className="h-4 w-4" />
            {drafting ? "Drafting…" : "Draft with AI"}
          </Button>
          {isPending && (
            <span className="text-xs text-muted-foreground">
              Approve or discard the current draft to write another.
            </span>
          )}
        </div>
        {error && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={runDraft} disabled={drafting}>
              Retry
            </Button>
          </div>
        )}
      </section>

      {draft && (
        <section className="mt-6 grid gap-6 md:grid-cols-[1fr_280px]">
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-foreground">
                {draftHeading(draftLanguage)}
              </h2>
              <StatusBadge status={draft.status} />
            </div>
            <Textarea
              value={body}
              onChange={(e) => updateBody(e.target.value)}
              readOnly={!isPending}
              rows={12}
              className="mt-4 resize-y bg-background leading-relaxed"
              aria-label="Draft message"
            />

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {isPending && (
                <>
                  <Button
                    onClick={() => runDecision("approve")}
                    disabled={
                      deciding !== null || checking || body.trim() === "" || !gate.approveEnabled
                    }
                  >
                    {deciding === "approve"
                      ? "Approving…"
                      : confirmHigh
                        ? "Approve anyway"
                        : "Approve"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => runDecision("discard")}
                    disabled={deciding !== null || checking}
                  >
                    {deciding === "discard" ? "Discarding…" : "Discard"}
                  </Button>
                  <RiskStatus
                    neverChecked={neverChecked}
                    failed={riskError !== null}
                    stale={stale}
                    partial={partial}
                    flagCount={flags.length}
                    highCount={highCount}
                  />
                </>
              )}
              {draft.status === "approved" && (
                <Button onClick={copyDraft}>
                  <Copy className="h-4 w-4" /> Copy message
                </Button>
              )}
              {!isPending && (
                <Button variant="ghost" onClick={startOver}>
                  New draft
                </Button>
              )}
            </div>

            {isPending && partial && (
              <PartialAcknowledgment
                checked={partialAck}
                onChange={setPartialAck}
                disabled={deciding !== null}
              />
            )}

            {isPending && confirmHigh && (
              <p className="mt-3 flex items-center gap-2 text-sm text-destructive" role="alert">
                <AlertTriangle className="h-4 w-4" />
                {highCount} high-severity flag{highCount === 1 ? " is" : "s are"} showing. Click
                “Approve anyway” to approve — the decision is yours.
              </p>
            )}

            <div className="mt-5 rounded-md border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <ShieldCheck className="h-4 w-4" /> Risk check
                </h3>
                {isPending && !(risk && risk.status === "partial") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={runRisk}
                    disabled={checking || deciding !== null || body.trim() === ""}
                  >
                    {checking ? "Checking…" : risk ? "Run risk check again" : "Run risk check"}
                  </Button>
                )}
              </div>

              <div className="mt-3 space-y-3">
                {riskError && <WarningBanner>{riskError}</WarningBanner>}
                {neverChecked && (
                  <p className="text-sm text-muted-foreground">
                    Risk check has not run. It only runs when you click “Run risk check”.
                  </p>
                )}
                {risk && (
                  <RiskResults
                    risk={risk}
                    body={body}
                    isPending={isPending}
                    appliedIds={appliedIds}
                    onApply={applyFlag}
                    onRetry={runRisk}
                    retryDisabled={checking || deciding !== null || body.trim() === ""}
                    checking={checking}
                  />
                )}
              </div>
            </div>
          </div>

          <aside className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-lg font-semibold text-foreground">Facts used</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Check each value against the tenant record before approving.
            </p>
            <dl className="mt-4 space-y-3">
              {facts.map((f) => (
                <div key={f.field} className="border-b border-border pb-3 last:border-0 last:pb-0">
                  <dt className="text-xs text-muted-foreground">{f.label}</dt>
                  <dd className="font-medium text-foreground">{f.value}</dd>
                  <dd className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    demo_tenants.{f.field}
                  </dd>
                </div>
              ))}
            </dl>
          </aside>
        </section>
      )}

      <TenantQaPanel tenant={tenant} />
    </div>
  );
}

function RiskStatus({
  neverChecked,
  failed,
  stale,
  partial,
  flagCount,
  highCount,
}: {
  neverChecked: boolean;
  failed: boolean;
  stale: boolean;
  partial: boolean;
  flagCount: number;
  highCount: number;
}) {
  let text: string;
  let tone: "muted" | "warn" | "bad" = "muted";
  if (failed) {
    text = "Risk check couldn't run — review carefully";
    tone = "warn";
  } else if (neverChecked) {
    text = "Risk check has not run";
  } else if (stale) {
    text = "Draft changed since the check";
    tone = "warn";
  } else if (partial) {
    text = `Incomplete — language review did not run${highCount ? ` · ${highCount} high` : ""}`;
    tone = highCount ? "bad" : "warn";
  } else if (flagCount === 0) {
    text = "No flags from the checks that ran";
  } else {
    text = `${flagCount} flag${flagCount === 1 ? "" : "s"}${highCount ? ` · ${highCount} high` : ""}`;
    tone = highCount ? "bad" : "warn";
  }
  return (
    <span
      className={cn(
        "ml-1 text-xs",
        tone === "muted" && "text-muted-foreground",
        tone === "warn" && "font-medium text-warning-foreground",
        tone === "bad" && "font-medium text-destructive",
      )}
    >
      {text}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium capitalize text-foreground">{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "approved") {
    return (
      <span className="rounded-full bg-success px-3 py-1 text-xs font-medium text-success-foreground">
        Approved — ready to copy
      </span>
    );
  }
  if (status === "discarded") {
    return (
      <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
        Discarded
      </span>
    );
  }
  return (
    <span className="rounded-full bg-warning px-3 py-1 text-xs font-medium text-warning-foreground">
      Pending approval — not sent
    </span>
  );
}

function ChoiceRow<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              value === o.value
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-foreground hover:bg-secondary",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
