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
    "relative rounded-sm px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground";
  const activeClass =
    "bg-accent text-accent-foreground after:absolute after:inset-x-2 after:-bottom-[13px] after:h-0.5 after:bg-primary";

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-card/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
          <Link
            to="/tenants"
            className="flex items-center gap-2.5 font-display text-base font-semibold uppercase tracking-[0.14em] text-foreground"
          >
            <span aria-hidden className="glow-primary h-2.5 w-2.5 rounded-[2px] bg-primary" />
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
