import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";

import { readStoredRisk, SeverityBadge } from "@/components/risk-check";
import { actionLabel, describeAuditEntry, fullRecordText } from "@/lib/copilot-audit";
import { categoryLabel } from "@/lib/copilot-risk";
import { draftLanguageLabel, messageTypeLabel, toneLabel } from "@/lib/copilot-shared";
import { getDraft, listAudit } from "@/lib/copilot.functions";
import { cn } from "@/lib/utils";

const auditQuery = queryOptions({
  queryKey: ["audit"],
  queryFn: () => listAudit(),
});

export const Route = createFileRoute("/_authenticated/audit")({
  head: () => ({
    meta: [
      { title: "Audit log — Rentropy Copilot" },
      { name: "description", content: "Every draft generated, risk-checked, approved, discarded, or failed." },
      { property: "og:title", content: "Audit log — Rentropy Copilot" },
      {
        property: "og:description",
        content: "Every draft generated, risk-checked, approved, discarded, or failed.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(auditQuery),
  component: AuditPage,
});

type AuditRow = Awaited<ReturnType<typeof listAudit>>[number];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function AuditPage() {
  const { data: rows } = useSuspenseQuery(auditQuery);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <h1 className="text-3xl font-semibold text-foreground">Audit log</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Read-only, oldest first. Click an entry to see everything it recorded.
      </p>

      <div className="mt-6 overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="bg-secondary text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Time</th>
              <th className="px-4 py-3 font-medium">Tenant</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Model</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => {
              const expanded = open.has(r.id);
              return (
                <Fragment key={r.id}>
                  <tr
                    className={cn("cursor-pointer hover:bg-secondary/60", expanded && "bg-secondary/40")}
                    onClick={() => toggle(r.id)}
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={`audit-detail-${r.id}`}
                        className="inline-flex items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(r.id);
                        }}
                      >
                        {expanded ? (
                          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
                        )}
                        {formatTime(r.created_at)}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-foreground">{r.tenant_name ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          r.action === "model_error"
                            ? "text-destructive"
                            : r.action === "approve" || r.action === "approved_after_partial_review"
                              ? "text-success-foreground"
                              : "text-foreground"
                        }
                      >
                        {actionLabel(r.action)}
                      </span>
                      {r.detail && (
                        <span className="block text-xs text-muted-foreground">{r.detail}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {r.model_id ?? "—"}
                    </td>
                  </tr>
                  {expanded && (
                    <tr id={`audit-detail-${r.id}`} className="bg-background">
                      <td colSpan={4} className="px-4 py-4">
                        <EntryDetail row={r} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                  Nothing logged yet. Draft a message to see entries here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LabeledLines({ lines }: { lines: { label: string; value: string }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
      {lines.map((l) => (
        <Fragment key={l.label}>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground sm:pt-0.5">
            {l.label}
          </dt>
          <dd className="break-words text-foreground">{l.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="mb-2 text-sm font-semibold text-foreground">{children}</h3>;
}

function EntryDetail({ row }: { row: AuditRow }) {
  const lines = describeAuditEntry(row.action, row.model_id, row.full_detail);
  const record = fullRecordText(row.full_detail);

  return (
    <div className="space-y-5">
      <section>
        <SectionTitle>{actionLabel(row.action)}</SectionTitle>
        {lines.length > 0 ? (
          <LabeledLines lines={lines} />
        ) : (
          <p className="text-muted-foreground">No details were recorded for this entry.</p>
        )}
      </section>

      {row.draft_id && <LinkedDraft draftId={row.draft_id} />}

      <section>
        <SectionTitle>Full record</SectionTitle>
        {record ? (
          <pre className="max-h-80 overflow-auto rounded-md border border-border bg-secondary p-3 font-mono text-xs text-foreground whitespace-pre-wrap break-words">
            {record}
          </pre>
        ) : (
          <p className="text-muted-foreground">Nothing else was stored with this entry.</p>
        )}
      </section>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  discarded: "Discarded",
};

function LinkedDraft({ draftId }: { draftId: string }) {
  // Loaded the first time the entry is opened, then kept for reopening.
  const { data: draft, isPending, isError } = useQuery({
    queryKey: ["audit-draft", draftId],
    queryFn: () => getDraft({ data: { draftId } }),
  });

  if (isPending) {
    return (
      <section>
        <SectionTitle>Linked draft</SectionTitle>
        <p className="text-muted-foreground">Loading the draft…</p>
      </section>
    );
  }
  if (isError) {
    return (
      <section>
        <SectionTitle>Linked draft</SectionTitle>
        <p className="text-destructive">Couldn't load this draft. Close and reopen the entry to try again.</p>
      </section>
    );
  }
  if (!draft) {
    return (
      <section>
        <SectionTitle>Linked draft</SectionTitle>
        <p className="text-muted-foreground">This draft could not be found.</p>
      </section>
    );
  }

  const risk = readStoredRisk(draft.risk_flags);
  const flags = risk
    ? [...risk.deterministic_flags, ...risk.semantic_flags].sort((a, b) => a.start - b.start)
    : [];

  return (
    <section>
      <SectionTitle>Linked draft</SectionTitle>
      <LabeledLines
        lines={[
          { label: "Status", value: STATUS_LABELS[draft.status] ?? draft.status },
          { label: "Message type", value: messageTypeLabel(draft.message_type) },
          { label: "Tone", value: toneLabel(draft.tone) },
          { label: "Language", value: draftLanguageLabel(draft.language) },
          { label: "Created", value: formatTime(draft.created_at) },
          { label: "Decided", value: draft.decided_at ? formatTime(draft.decided_at) : "Not decided yet" },
        ]}
      />

      <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Message text</p>
      <div className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-card p-3 text-foreground">
        {draft.draft_body}
      </div>

      <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Risk check</p>
      {!risk ? (
        <p className="mt-1 text-muted-foreground">
          {draft.risk_checked_at ? "The stored risk result can't be read." : "Risk check has not run on this text."}
        </p>
      ) : (
        <div className="mt-1 space-y-2">
          <p className="text-foreground">
            {risk.status === "partial"
              ? "Incomplete — rule checks ran, the language review did not run"
              : "Complete — rule checks and language review ran"}
            {draft.risk_checked_at && (
              <span className="text-muted-foreground"> · checked {formatTime(draft.risk_checked_at)}</span>
            )}
          </p>
          {risk.checked_body !== draft.draft_body && (
            <p className="text-sm text-warning-foreground">
              The check ran on an earlier version of this text.
            </p>
          )}
          {flags.length === 0 ? (
            <p className="text-muted-foreground">No flags from the checks that ran.</p>
          ) : (
            <ul className="space-y-2">
              {flags.map((f) => (
                <li key={f.id} className="rounded-md border border-border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={f.severity} />
                    <span className="text-sm font-medium text-foreground">{categoryLabel(f.category)}</span>
                  </div>
                  <blockquote className="mt-2 border-l-2 border-border pl-3 text-foreground">
                    “{f.quote}”
                  </blockquote>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
