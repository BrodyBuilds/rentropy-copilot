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

      <div className="console-panel mt-6 overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-secondary/70">
            <tr>
              <th className="console-label px-4 py-2.5 font-medium">Time</th>
              <th className="console-label px-4 py-2.5 font-medium">Tenant</th>
              <th className="console-label px-4 py-2.5 font-medium">Action</th>
              <th className="console-label px-4 py-2.5 font-medium">Model</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => {
              const expanded = open.has(r.id);
              return (
                <Fragment key={r.id}>
                  <tr
                    className={cn(
                      "cursor-pointer transition-colors hover:bg-secondary/60",
                      expanded && "bg-accent/40 hover:bg-accent/50",
                    )}
                    onClick={() => toggle(r.id)}
                  >
                    <td
                      className={cn(
                        "whitespace-nowrap px-4 py-2.5 align-top text-muted-foreground",
                        r.action === "model_error"
                          ? "shadow-[inset_3px_0_0_var(--color-destructive)]"
                          : expanded
                            ? "shadow-[inset_3px_0_0_var(--color-primary)]"
                            : "shadow-[inset_3px_0_0_transparent]",
                      )}
                    >
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={`audit-detail-${r.id}`}
                        className="num inline-flex items-center gap-1.5 rounded-sm text-left text-xs text-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(r.id);
                        }}
                      >
                        {expanded ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                        {formatTime(r.created_at)}
                      </button>
                    </td>
                    <td className="px-4 py-2.5 align-top text-foreground">{r.tenant_name ?? "—"}</td>
                    <td className="px-4 py-2.5 align-top">
                      <span
                        className={
                          r.action === "model_error"
                            ? "font-semibold text-destructive"
                            : r.action === "approve" || r.action === "approved_after_partial_review"
                              ? "font-medium text-success-foreground"
                              : "font-medium text-foreground"
                        }
                      >
                        {actionLabel(r.action)}
                      </span>
                      {r.detail && (
                        <span className="block text-xs text-muted-foreground">{r.detail}</span>
                      )}
                    </td>
                    <td className="num px-4 py-2.5 align-top text-[11px] text-muted-foreground">
                      {r.model_id ?? "—"}
                    </td>
                  </tr>
                  {expanded && (
                    <tr id={`audit-detail-${r.id}`} className="bg-background">
                      <td colSpan={4} className="px-6 py-5 shadow-[inset_3px_0_0_var(--color-primary)]">
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
    <dl className="grid grid-cols-1 gap-x-8 gap-y-2.5 rounded-md border border-border bg-card px-4 py-3 sm:grid-cols-[max-content_1fr]">
      {lines.map((l) => (
        <Fragment key={l.label}>
          <dt className="console-label sm:pt-0.5">{l.label}</dt>
          <dd className="break-words text-sm text-foreground">{l.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h3 className="num mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
      <span aria-hidden className="h-px w-3 bg-primary" />
      {children}
    </h3>
  );
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
          <pre className="num max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card p-3 text-xs leading-5 text-foreground/90">
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

      <p className="console-label mt-4">Message text</p>
      <div className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-card p-3 text-[15px] leading-7 text-foreground">
        {draft.draft_body}
      </div>

      <p className="console-label mt-4">Risk check</p>
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
              <span className="text-muted-foreground">
                {" "}· checked <span className="num text-xs">{formatTime(draft.risk_checked_at)}</span>
              </span>
            )}
          </p>
          {risk.checked_body !== draft.draft_body && (
            <p className="rounded-sm bg-warning px-2 py-1 text-sm font-semibold text-warning-foreground">
              The check ran on an earlier version of this text.
            </p>
          )}
          {flags.length === 0 ? (
            <p className="text-muted-foreground">No flags from the checks that ran.</p>
          ) : (
            <ul className="space-y-2">
              {flags.map((f) => (
                <li
                  key={f.id}
                  className={cn(
                    "rounded-md border border-l-4 border-border bg-card p-3",
                    f.severity === "high" && "border-l-destructive",
                    f.severity === "medium" && "border-l-warning-foreground",
                    f.severity === "low" && "border-l-accent-foreground/50",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={f.severity} />
                    <span className="text-sm font-semibold text-foreground">{categoryLabel(f.category)}</span>
                  </div>
                  <blockquote
                    className={cn(
                      "mt-2 pl-1 text-foreground",
                      f.severity === "high" && "font-semibold",
                    )}
                  >
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
