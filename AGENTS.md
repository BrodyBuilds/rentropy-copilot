<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Project rules
- `/` is the public sign-in landing; signed-in pages live under `src/routes/_authenticated/` (client-only gate, redirects to `/`). Each page is its own route file with its own head() metadata.
- All model calls go through `callModel(systemPrompt, userPrompt)` in `src/lib/copilot-model.server.ts`, called only from the `copilotDraft` server function — a plain `fetch` chat-completions POST configured solely by `META_MODEL_API_KEY`, `META_MODEL_ID`, `META_MODEL_API_BASE_URL`, so a model/provider swap is an env change. Do not add `@lovable.dev/ai-gateway` or any gateway SDK.
- The "Facts used" panel and the model prompt are built from the same `buildFacts()` in `src/lib/copilot-shared.ts`, so the reviewer sees exactly what the model was given; facts without a source value are dropped.
- Data access is RLS-scoped to the demo account via `public.is_demo_user()` (reads `app_metadata.demo`, set only server-side); `anon` has no grants. Audit log is append-only (no update/delete grants or policies).
- Server functions use `requireSupabaseAuth` + `context.supabase` (RLS as user); the bearer token is attached by the function middleware in `src/start.ts`. The admin client is only used inside `startDemoSession`.
