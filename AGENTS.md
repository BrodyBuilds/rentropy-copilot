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
- Server functions use `requireSupabaseAuth` + `context.supabase` (RLS as user); the bearer token is attached by the function middleware in `src/start.ts`. The admin client is only used inside `startDemoSession`.
- Risk check logic lives in `src/lib/copilot-risk.ts`: amounts, dates, identity and late-fee/deposit rules are pure code, the model only proposes language flags, and every model quote must match the draft exactly once or it is dropped and counted — so the model output shape is never trusted. Results are stored only in `copilot_drafts.risk_flags` (with `checked_body`), never in new tables; a failed check clears them so it can never look like a pass.
- Photo triage (`src/lib/copilot-triage.functions.ts`): photos live in the private `maintenance-photos` bucket and are only shown or sent to models via short-lived signed links. Concept choice, the five-field answer schema, and the hard rules (no cause/health/cost in findings, no cost in drafts, no findings → code-written clearer-photo request) are pure code in `src/lib/copilot-triage.ts`; SAM text parsing and the per-concept stage are in `src/lib/copilot-segmentation.ts`: an empty output lane is zero regions for that concept (not an error), while HTTP errors, missing settings and malformed non-empty replies still fail as model_error. The tenant reply is a normal `copilot_drafts` row (maintenance_update) so it reuses risk check and approval; the work order lives in `copilot_photo_triage.findings`.
