import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, ArrowLeft, ClipboardCheck, Copy, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { approveWorkOrder, getTriage } from "@/lib/copilot-triage.functions";
import { urgencyLabel, type TriageRegion } from "@/lib/copilot-triage";
import { cn } from "@/lib/utils";

const triageQuery = (triageId: string) =>
  queryOptions({
    queryKey: ["triage", triageId],
    queryFn: () => getTriage({ data: { triageId } }),
    // Signed photo links last 10 minutes; refresh well before they expire.
    staleTime: 5 * 60 * 1000,
    refetchInterval: 8 * 60 * 1000,
  });

export const Route = createFileRoute("/_authenticated/triage/$triageId")({
  head: () => ({
    meta: [
      { title: "Photo triage result — Rentropy Copilot" },
      {
        name: "description",
        content: "What a maintenance photo shows, what it can't tell you, and drafts to review.",
      },
      { property: "og:title", content: "Photo triage result — Rentropy Copilot" },
      {
        property: "og:description",
        content: "What a maintenance photo shows, what it can't tell you, and drafts to review.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: async ({ context, params }) => {
    const row = await context.queryClient.ensureQueryData(triageQuery(params.triageId));
    if (!row) throw notFound();
  },
  component: TriageResultPage,
  notFoundComponent: () => (
    <div className="text-center">
      <p className="text-muted-foreground">That photo triage doesn't exist.</p>
      <Link to="/triage" className="mt-4 inline-block text-sm text-primary underline">
        Back to photo triage
      </Link>
    </div>
  ),
});

function TriageResultPage() {
  const { triageId } = Route.useParams();
  const { data: triage } = useSuspenseQuery(triageQuery(triageId));
  const approve = useServerFn(approveWorkOrder);
  const queryClient = useQueryClient();

  const workOrder = triage?.findings?.work_order ?? null;
  const [orderBody, setOrderBody] = useState(workOrder?.body ?? "");
  const [approving, setApproving] = useState(false);
  useEffect(() => {
    if (workOrder) setOrderBody(workOrder.body);
  }, [workOrder?.body, workOrder?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!triage) return null;
  const { findings, segmentation, tenant } = triage;
  const regions = segmentation?.regions ?? [];

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    } catch {
      toast.message("Approved. Click “Copy work order” to copy it.");
    }
  }

  async function approveAndCopy() {
    setApproving(true);
    try {
      const approved = await approve({ data: { triage_id: triageId, body: orderBody } });
      await copy(approved.body);
      await queryClient.invalidateQueries({ queryKey: ["triage", triageId] });
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : "Couldn't approve the work order");
    } finally {
      setApproving(false);
    }
  }

  return (
    <div>
      <Link
        to="/triage"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Photo triage
      </Link>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-foreground">{tenant?.full_name ?? "Photo"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tenant?.property_label} ·{" "}
            <span className="num text-foreground/90">
              {new Date(triage.created_at).toLocaleString("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </span>{" "}
            · looked for: {triage.concept_prompt}
          </p>
        </div>
      </div>

      {(triage.status === "failed" || triage.status === "processing") && (
        <div className="mt-6 flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive">
          <AlertTriangle className="h-4 w-4" />
          This photo triage couldn't finish, so there are no findings. Run it again from the Photo
          triage page.
        </div>
      )}

      <section className="mt-6 grid gap-6 md:grid-cols-[minmax(0,1fr)_320px]">
        <div className="console-panel p-4">
          {triage.photoUrl ? (
            <PhotoWithRegions url={triage.photoUrl} regions={regions} />
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              The photo link couldn't be created. Reload the page to try again.
            </p>
          )}
          {segmentation && (
            <div className="mt-3 text-xs text-muted-foreground">
              {regions.length === 0 ? (
                <p>SAM located no regions for: {segmentation.requests.map((r) => r.concept).join(", ")}.</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {regions.map((r) => (
                    <li key={r.n} className="num rounded-sm border border-primary/40 bg-accent/60 px-2 py-0.5 text-accent-foreground">
                      Region {r.n}: {r.concept}
                      {r.c !== null && ` · ${Math.round(r.c * 100)}%`}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 font-mono text-[11px]">{segmentation.sam_model_id}</p>
            </div>
          )}
        </div>

        {findings && (
          <aside className="space-y-4">
            {findings.note && (
              <div className="console-panel p-4">
                <h2 className="console-label">
                  Tenant's note
                </h2>
                <p className="mt-1 text-sm text-foreground">“{findings.note}”</p>
              </div>
            )}
            <div className="console-panel border-l-2 border-l-primary p-4">
              <h2 className="console-label">Urgency and routing</h2>
              <p className="mt-1.5 text-base font-semibold text-foreground">
                {findings.urgency_routing.urgency
                  ? urgencyLabel(findings.urgency_routing.urgency)
                  : "Not determinable from this photo"}
              </p>
              <p className="text-sm text-muted-foreground">Vendor: {findings.urgency_routing.vendor}</p>
              {findings.urgency_routing.why && (
                <p className="mt-1 text-xs text-muted-foreground">{findings.urgency_routing.why}</p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                A person decides. Nothing is sent or booked automatically.
              </p>
            </div>
          </aside>
        )}
      </section>

      {findings && (
        <section className="mt-6 grid gap-6 md:grid-cols-3">
          <Panel title="Visible findings">
            {findings.photo_usable ? (
              <ul className="space-y-3">
                {findings.visible_findings.map((f, i) => (
                  <li key={i} className="text-sm">
                    <p className="text-foreground">{f.what}</p>
                    {f.where && <p className="text-muted-foreground">Where: {f.where}</p>}
                    {f.regions.length > 0 && (
                      <p className="num mt-1 text-[11px] font-medium text-primary">
                        SAM {f.regions.length === 1 ? "region" : "regions"} {f.regions.join(", ")}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No findings. The photo can't support visible findings, so the only draft asks the
                tenant for clearer photos.
              </p>
            )}
            {findings.dropped_findings > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                {findings.dropped_findings} finding{findings.dropped_findings === 1 ? " was" : "s were"}{" "}
                removed because it named a cause, a health claim, or a cost — a photo can't show those.
              </p>
            )}
          </Panel>
          <Panel title="Not determinable from the photo">
            <PlainList items={findings.not_determinable} empty="Nothing listed." />
          </Panel>
          <Panel title="Questions to ask the tenant">
            <PlainList items={findings.context_questions} empty="No questions listed." />
          </Panel>
        </section>
      )}

      {findings && tenant && (
        <section className="mt-6 grid gap-6 md:grid-cols-2">
          <Panel title="Reply to the tenant">
            <p className="text-sm text-muted-foreground">
              {findings.photo_usable
                ? "Saved as a maintenance update draft. Open it to run the risk check, edit, and approve."
                : "Saved as a draft asking for a wide shot, a close-up, and the shutoff valve if water is involved."}
            </p>
            {triage.draft && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button asChild variant="outline" size="sm">
                  <Link
                    to="/tenants/$tenantId"
                    params={{ tenantId: tenant.id }}
                    search={{ draft: triage.draft.id }}
                  >
                    <ExternalLink className="h-4 w-4" /> Open tenant reply draft
                  </Link>
                </Button>
                <span className="text-xs text-muted-foreground">
                  {triage.draft.status === "pending"
                    ? triage.draft.risk_checked_at
                      ? "Pending approval — risk checked"
                      : "Pending approval — risk check has not run"
                    : triage.draft.status === "approved"
                      ? "Approved"
                      : "Discarded"}
                </span>
              </div>
            )}
          </Panel>

          <Panel title="Work order summary for a vendor">
            {workOrder ? (
              <>
                <Textarea
                  value={orderBody}
                  onChange={(e) => setOrderBody(e.target.value)}
                  readOnly={workOrder.status !== "pending"}
                  rows={8}
                  className="bg-background text-[15px] leading-7"
                  aria-label="Work order summary"
                />
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {workOrder.status === "pending" ? (
                    <Button onClick={approveAndCopy} disabled={approving || orderBody.trim() === ""}>
                      <ClipboardCheck className="h-4 w-4" />
                      {approving ? "Approving…" : "Approve and copy"}
                    </Button>
                  ) : (
                    <>
                      <span className="num rounded-sm border border-success-foreground/40 bg-success px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-success-foreground">
                        Approved — ready to copy
                      </span>
                      <Button variant="outline" size="sm" onClick={() => copy(workOrder.body)}>
                        <Copy className="h-4 w-4" /> Copy work order
                      </Button>
                    </>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Copilot never contacts vendors. Paste it wherever you book work.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No work order — wait for a clearer photo first.
              </p>
            )}
          </Panel>
        </section>
      )}
    </div>
  );
}

function pct(value: number, total: number): string {
  return `${Math.min(100, Math.max(0, (value / total) * 100))}%`;
}

function PhotoWithRegions({ url, regions }: { url: string; regions: TriageRegion[] }) {
  return (
    <div className="relative mx-auto w-fit max-w-full overflow-hidden rounded-md">
      <img src={url} alt="Maintenance photo from the tenant" className="block max-h-[560px] w-auto max-w-full" />
      {regions.map((r) => (
        <div
          key={r.n}
          className="glow-primary pointer-events-none absolute rounded-sm border-2 border-primary bg-primary/10"
          style={{
            left: pct(r.x1, r.w),
            top: pct(r.y1, r.h),
            width: pct(r.x2 - r.x1, r.w),
            height: pct(r.y2 - r.y1, r.h),
          }}
        >
          <span className="num absolute left-0 top-0 rounded-br-sm bg-primary px-1.5 py-0.5 text-[11px] font-bold leading-none text-primary-foreground">
            {r.n}
          </span>
        </div>
      ))}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="console-panel p-4">
      <h2 className="console-label mb-3 border-b border-border pb-2">{title}</h2>
      {children}
    </div>
  );
}

function PlainList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className={cn("list-disc space-y-1.5 pl-4 text-sm text-foreground marker:text-primary")}>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
