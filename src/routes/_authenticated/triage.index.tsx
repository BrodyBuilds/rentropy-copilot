import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Camera, ChevronRight, ScanSearch } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { listTenants } from "@/lib/copilot.functions";
import { TONES, type Tone } from "@/lib/copilot-shared";
import { listTriages, runPhotoTriage } from "@/lib/copilot-triage.functions";
import { TRIAGE_FAILED_MESSAGE } from "@/lib/copilot-triage";
import { cn } from "@/lib/utils";

const tenantsQuery = queryOptions({ queryKey: ["tenants"], queryFn: () => listTenants() });
const triagesQuery = queryOptions({ queryKey: ["triages"], queryFn: () => listTriages() });

export const Route = createFileRoute("/_authenticated/triage/")({
  head: () => ({
    meta: [
      { title: "Photo triage — Rentropy Copilot" },
      {
        name: "description",
        content: "Upload a tenant's maintenance photo to see what's visible and draft replies.",
      },
      { property: "og:title", content: "Photo triage — Rentropy Copilot" },
      {
        property: "og:description",
        content: "Upload a tenant's maintenance photo to see what's visible and draft replies.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(tenantsQuery),
      context.queryClient.ensureQueryData(triagesQuery),
    ]),
  component: TriagePage,
});

const STATUS_LABELS: Record<string, string> = {
  processing: "Didn't finish",
  completed: "Findings ready",
  needs_clearer_photo: "Needs a clearer photo",
  failed: "Couldn't run",
};

const MAX_UPLOAD_BYTES = 250 * 1024;

/** Shrink a photo in the browser to a JPEG of at most ~250 KB; falls back to the original if it can't be decoded. */
async function shrinkPhoto(file: File): Promise<File> {
  let img: HTMLImageElement;
  const url = URL.createObjectURL(file);
  try {
    img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = url;
    });
  } catch {
    URL.revokeObjectURL(url);
    return file;
  }
  try {
    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;
    if (!w0 || !h0) return file;
    const encode = (maxDim: number, quality: number) =>
      new Promise<Blob | null>((resolve) => {
        const scale = Math.min(1, maxDim / Math.max(w0, h0));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w0 * scale));
        canvas.height = Math.max(1, Math.round(h0 * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(resolve, "image/jpeg", quality);
      });

    let maxDim = 1600;
    let quality = 0.85;
    let blob = await encode(maxDim, quality);
    if (!blob) return file;
    while (blob.size > MAX_UPLOAD_BYTES && quality > 0.5 + 1e-9) {
      quality = Math.max(0.5, Math.round((quality - 0.1) * 100) / 100);
      blob = (await encode(maxDim, quality)) ?? blob;
    }
    while (blob.size > MAX_UPLOAD_BYTES && maxDim > 800) {
      maxDim = Math.max(800, Math.round(maxDim * 0.75));
      blob = (await encode(maxDim, quality)) ?? blob;
    }
    const base = file.name.replace(/\.[^.]*$/, "") || "photo";
    return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function TriagePage() {
  const { data: tenants } = useSuspenseQuery(tenantsQuery);
  const { data: runs } = useSuspenseQuery(triagesQuery);
  const run = useServerFn(runPhotoTriage);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [tenantId, setTenantId] = useState<string>(tenants[0]?.id ?? "");
  const [photo, setPhoto] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [tone, setTone] = useState<Tone>("friendly");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!photo || !tenantId) return;
    setRunning(true);
    setError(null);
    try {
      const upload = await shrinkPhoto(photo);
      const form = new FormData();
      form.append("tenant_id", tenantId);
      form.append("note", note);
      form.append("tone", tone);
      form.append("photo", upload);
      const result = await run({ data: form });
      await queryClient.invalidateQueries({ queryKey: ["triages"] });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await navigate({ to: "/triage/$triageId", params: { triageId: result.triageId } });
    } catch (e) {
      console.error(e);
      setError(TRIAGE_FAILED_MESSAGE);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <h1 className="text-3xl font-semibold text-foreground">Photo triage</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Upload a photo a tenant sent about a maintenance problem. Copilot outlines what it can see,
        lists what the photo can't tell you, and drafts replies for you to review.
      </p>

      <section className="mt-6 rounded-lg border border-border bg-card p-5">
        <div role="radiogroup" aria-label="Tenant">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tenant</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {tenants.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={tenantId === t.id}
                disabled={running}
                onClick={() => setTenantId(t.id)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  tenantId === t.id
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-foreground hover:bg-secondary",
                )}
              >
                {t.full_name} · {t.property_label}
              </button>
            ))}
          </div>
        </div>

        <div role="radiogroup" aria-label="Tone" className="mt-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tone</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {TONES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={tone === t.value}
                disabled={running}
                onClick={() => setTone(t.value)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  tone === t.value
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-foreground hover:bg-secondary",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Used for the reply to the tenant. The work order stays neutral.
          </p>
        </div>

        <div className="mt-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Photo</p>
          <label className="mt-2 flex cursor-pointer items-center gap-3 rounded-md border border-dashed border-border bg-background px-4 py-4 text-sm text-muted-foreground hover:bg-secondary">
            <Camera className="h-5 w-5" />
            <span className="text-foreground">{photo ? photo.name : "Choose a JPG, PNG, or WebP photo (up to 10 MB)"}</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              aria-label="Maintenance photo"
              disabled={running}
              onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        <div className="mt-5">
          <label
            htmlFor="triage-note"
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Tenant's note (optional)
          </label>
          <Textarea
            id="triage-note"
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            disabled={running}
            rows={3}
            placeholder="e.g. There's a brown stain on the bathroom ceiling and it's dripping"
            className="mt-2 bg-background"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            The note picks what to look for (up to three things). With no note, Copilot looks for a
            water stain.
          </p>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <Button onClick={submit} disabled={running || !photo || !tenantId}>
            <ScanSearch className="h-4 w-4" />
            {running ? "Reading the photo…" : "Run photo triage"}
          </Button>
          {running && (
            <span className="text-xs text-muted-foreground">This can take up to a minute.</span>
          )}
        </div>

        {error && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={submit} disabled={running || !photo}>
              Retry
            </Button>
          </div>
        )}
      </section>

      <h2 className="mt-10 text-lg font-semibold text-foreground">Earlier photos</h2>
      <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {runs.map((r) => (
          <li key={r.id}>
            <Link
              to="/triage/$triageId"
              params={{ triageId: r.id }}
              className="flex items-center justify-between gap-4 px-5 py-3 transition-colors hover:bg-secondary"
            >
              <div>
                <p className="font-medium text-foreground">{r.tenant_name ?? "—"}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(r.created_at).toLocaleString("en-US", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}{" "}
                  · looked for: {r.concept_prompt}
                </p>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <span
                  className={cn(
                    r.status === "failed" || r.status === "processing"
                      ? "text-destructive"
                      : r.status === "needs_clearer_photo"
                        ? "text-warning-foreground"
                        : "text-foreground",
                  )}
                >
                  {STATUS_LABELS[r.status] ?? r.status}
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </div>
            </Link>
          </li>
        ))}
        {runs.length === 0 && (
          <li className="px-5 py-8 text-center text-sm text-muted-foreground">No photos yet.</li>
        )}
      </ul>
    </div>
  );
}
