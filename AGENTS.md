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
- All model calls go through `src/lib/copilot-model.server.ts`: `callModel(systemPrompt, userPrompt, options?)` (chat-completions, optional `images` URLs) and `callSegmentation(concept, imageUrl)` (SAM via POST `{base}/responses`, streaming). Both are plain `fetch` configured solely by `META_MODEL_API_KEY`, `META_MODEL_API_BASE_URL`, `META_MODEL_ID`, `META_SAM_MODEL_ID`, so a model/provider swap is an env change. Model calls happen only in server functions triggered by a landlord click. Do not add `@lovable.dev/ai-gateway` or any gateway SDK.
- The "Facts used" panel and the model prompt are built from the same `buildFacts()` in `src/lib/copilot-shared.ts`, so the reviewer sees exactly what the model was given; facts without a source value are dropped.
- Data access is RLS-scoped to the demo account via `public.is_demo_user()` (reads `app_metadata.demo`, set only server-side); `anon` has no grants. Audit log is append-only (no update/delete grants or policies).
- Server functions use `requireSupabaseAuth` + `context.supabase` (RLS as user) for every read, storage call and `copilot_audit_log` insert; the bearer token is attached by the function middleware in `src/start.ts`. Inserts/updates on `copilot_drafts` and `copilot_photo_triage` go only through `supabaseAdmin` (loaded inside the handler with `await import`), after the row or tenant was first read as the user, because `authenticated` has no INSERT/UPDATE grant there — so the server's decision gates can't be bypassed via the API. `demo_tenants` is read-only seed data (no INSERT/UPDATE grant). The admin client is also used by `startDemoSession`.
- Server functions check the returned `error` of every write that records evidence, a status or an audit row (supabase-js returns errors, it does not throw); a failed audit insert makes its operation report failure, and a failed triage run always ends `failed` with a `model_error` row via `failRun`.
- `src/lib/` has its own `AGENTS.md` (risk check, photo triage, tenant Q&A, draft language, audit page rules); read it before changing files there or the screens that use them.
