import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { startDemoSession } from "@/lib/copilot.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Rentropy Copilot — AI drafts for landlord messages" },
      {
        name: "description",
        content:
          "Draft tenant messages with AI, check every fact against the lease record, and approve before anything goes out.",
      },
      { property: "og:title", content: "Rentropy Copilot — AI drafts for landlord messages" },
      {
        property: "og:description",
        content: "Draft tenant messages with AI, check every fact, approve before it goes out.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const navigate = useNavigate();
  const startDemo = useServerFn(startDemoSession);
  const [loading, setLoading] = useState(false);

  async function enterDemo() {
    setLoading(true);
    try {
      const session = await startDemo();
      const { error } = await supabase.auth.setSession(session);
      if (error) throw error;
      await navigate({ to: "/tenants" });
    } catch (error) {
      console.error(error);
      toast.error("Couldn't start the demo. Please try again.");
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="console-panel w-full max-w-md border-t-2 border-t-primary p-8">
        <p className="num flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-primary">
          <span aria-hidden className="glow-primary h-2 w-2 rounded-full bg-primary" />
          Demo
        </p>
        <h1 className="mt-4 text-4xl font-semibold uppercase tracking-[0.06em] text-foreground">Rentropy Copilot</h1>
        <p className="mt-3 text-base leading-relaxed text-muted-foreground">
          Draft tenant messages with AI. Every draft waits for your approval, lists the facts it
          used, and is never sent for you.
        </p>
        <Button size="lg" className="mt-8 w-full" onClick={enterDemo} disabled={loading}>
          {loading ? "Opening workspace…" : "Enter demo workspace"}
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">
          Signs you into a shared demo landlord account. No messages are sent and no payments are
          touched.
        </p>
      </div>
    </main>
  );
}
