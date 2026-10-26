import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

import { listTenants } from "@/lib/copilot.functions";
import { formatCents } from "@/lib/copilot-shared";

const tenantsQuery = queryOptions({
  queryKey: ["tenants"],
  queryFn: () => listTenants(),
});

export const Route = createFileRoute("/_authenticated/tenants/")({
  head: () => ({
    meta: [
      { title: "Tenants — Rentropy Copilot" },
      { name: "description", content: "Pick a tenant to draft a message for." },
      { property: "og:title", content: "Tenants — Rentropy Copilot" },
      { property: "og:description", content: "Pick a tenant to draft a message for." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(tenantsQuery),
  component: TenantsPage,
});

function TenantsPage() {
  const { data: tenants } = useSuspenseQuery(tenantsQuery);

  return (
    <div>
      <h1 className="text-3xl font-semibold text-foreground">Tenants</h1>
      <p className="mt-1 text-sm text-muted-foreground">Pick a tenant to draft a message.</p>

      <ul className="mt-6 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {tenants.map((t) => (
          <li key={t.id}>
            <Link
              to="/tenants/$tenantId"
              params={{ tenantId: t.id }}
              className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-secondary"
            >
              <div>
                <p className="font-medium text-foreground">{t.full_name}</p>
                <p className="text-sm text-muted-foreground">{t.property_label}</p>
              </div>
              <div className="flex items-center gap-6 text-sm">
                <div className="text-right">
                  <p className="text-muted-foreground">Rent</p>
                  <p className="font-medium text-foreground">{formatCents(t.rent_cents)}</p>
                </div>
                <div className="text-right">
                  <p className="text-muted-foreground">Balance</p>
                  <p className="font-medium text-foreground">{formatCents(t.balance_cents)}</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </div>
            </Link>
          </li>
        ))}
        {tenants.length === 0 && (
          <li className="px-5 py-8 text-center text-sm text-muted-foreground">No tenants yet.</li>
        )}
      </ul>
    </div>
  );
}
