import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Copy, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { copilotDraft, decideDraft, getTenant, type DraftRow } from "@/lib/copilot.functions";
import {
  MESSAGE_TYPES,
  TONES,
  formatCents,
  formatDate,
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

  const [messageType, setMessageType] = useState<MessageType>("late_rent");
  const [tone, setTone] = useState<Tone>("firm_but_fair");
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftRow | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [body, setBody] = useState("");
  const [deciding, setDeciding] = useState<"approve" | "discard" | null>(null);

  if (!tenant) return null;

  async function runDraft() {
    setDrafting(true);
    setError(null);
    try {
      const result = await generate({
        data: { tenant_id: tenantId, message_type: messageType, tone },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDraft(result.draft);
      setFacts(result.facts);
      setBody(result.draft.draft_body);
    } catch (e) {
      console.error(e);
      setError("Something went wrong. Please try again.");
    } finally {
      setDrafting(false);
    }
  }

  async function runDecision(decision: "approve" | "discard") {
    if (!draft) return;
    setDeciding(decision);
    try {
      const updated = await decide({
        data: {
          draft_id: draft.id,
          decision,
          ...(decision === "approve" ? { draft_body: body } : {}),
        },
      });
      setDraft(updated);
      setBody(updated.draft_body);
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
  }

  async function copyDraft() {
    await navigator.clipboard.writeText(body);
    toast.success("Copied to clipboard");
  }

  const isPending = draft?.status === "pending";

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
        <ChoiceRow
          label="Message type"
          options={MESSAGE_TYPES}
          value={messageType}
          onChange={setMessageType}
          disabled={drafting || isPending}
        />
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
              <h2 className="text-lg font-semibold text-foreground">Draft</h2>
              <StatusBadge status={draft.status} />
            </div>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
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
                    disabled={deciding !== null || body.trim() === ""}
                  >
                    {deciding === "approve" ? "Approving…" : "Approve"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => runDecision("discard")}
                    disabled={deciding !== null}
                  >
                    {deciding === "discard" ? "Discarding…" : "Discard"}
                  </Button>
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

            <div className="mt-5 flex items-center justify-between gap-3 rounded-md border border-dashed border-border px-4 py-3">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <ShieldCheck className="h-4 w-4" /> Risk check — coming in slice 2
              </span>
              <Button size="sm" variant="outline" disabled>
                Run risk check
              </Button>
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
    </div>
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
