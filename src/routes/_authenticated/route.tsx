import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/" });
    return { user: data.user };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const navigate = useNavigate();

  async function signOut() {
    await supabase.auth.signOut();
    await navigate({ to: "/" });
  }

  const linkClass =
    "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground";
  const activeClass = "bg-secondary text-foreground";

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
          <Link to="/tenants" className="font-display text-lg font-semibold text-foreground">
            Rentropy Copilot
          </Link>
          <nav className="flex items-center gap-1">
            <Link to="/tenants" className={linkClass} activeProps={{ className: activeClass }}>
              Tenants
            </Link>
            <Link to="/triage" className={linkClass} activeProps={{ className: activeClass }}>
              Photo triage
            </Link>
            <Link to="/audit" className={linkClass} activeProps={{ className: activeClass }}>
              Audit log
            </Link>
            <Button variant="ghost" size="sm" onClick={signOut} className="ml-2">
              Sign out
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
