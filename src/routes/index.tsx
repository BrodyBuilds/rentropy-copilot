import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Rentropy Copilot" },
      { name: "description", content: "Rentropy Copilot workspace." },
      { property: "og:title", content: "Rentropy Copilot" },
      { property: "og:description", content: "Rentropy Copilot workspace." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 bg-background px-4 text-center">
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">Rentropy Copilot</h1>
      <p className="text-sm text-muted-foreground">Copilot workspace</p>
    </main>
  );
}
