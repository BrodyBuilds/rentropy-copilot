import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { listAudit } from "@/lib/copilot.functions";

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

const ACTION_LABELS: Record<string, string> = {
  generate: "Draft generated",
  model_error: "Model error",
  approve: "Approved",
  discard: "Discarded",
  risk_check: "Risk check",
};

function AuditPage() {
  const { data: rows } = useSuspenseQuery(auditQuery);

  return (
    <div>
      <h1 className="text-3xl font-semibold text-foreground">Audit log</h1>
      <p className="mt-1 text-sm text-muted-foreground">Read-only, oldest first.</p>

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
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                  {new Date(r.created_at).toLocaleString("en-US", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </td>
                <td className="px-4 py-3 text-foreground">{r.tenant_name ?? "—"}</td>
                <td className="px-4 py-3">
                  <span
                    className={
                      r.action === "model_error"
                        ? "text-destructive"
                        : r.action === "approve"
                          ? "text-success-foreground"
                          : "text-foreground"
                    }
                  >
                    {ACTION_LABELS[r.action] ?? r.action}
                  </span>
                  {r.detail && (
                    <span className="block text-xs text-muted-foreground">{r.detail}</span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  {r.model_id ?? "—"}
                </td>
              </tr>
            ))}
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
