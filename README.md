# Rentropy Copilot

An AI copilot for small landlords (1–50 units) that drafts lease-aware tenant messages, checks them for risky wording before they can be approved, and triages maintenance photos into a draft reply and a work order — with a human approving every single item. It never sends, never books, and never touches money.

## What was pre-existing, and what was built during the event

**Pre-existing (before Oct 26, 2026):** the Rentropy concept and brand. Rentropy (rentropy.app) is the builder's own property-management product — live as a demo, pre-pilot, no customers. The demo scenario design (two demo tenants, their properties, rents, and lease facts) was also worked out in preparation for this event. No code from the Rentropy product is in this repository.

**Built during the event (Oct 26 – Nov 4, 2026):** everything else in this repository. This repo (BrodyBuilds/rentropy-copilot) was created fresh on Oct 26, 2026. It began from Lovable's standard starter template (the template commit at the start of the history) and otherwise contains only work done during the event, with its full commit history intact:

- **Lease-aware message drafts** (Muse Spark 1.3 via the Meta Model API) generated only from the selected tenant's record, with a "Facts used" panel showing the record field behind every number. Drafts can also be written in Spanish — figures, dates, and the risk check work the same in either language.
- **A pre-send risk check, rules first:** deterministic North Carolina validators (late fee: greater of $15 or 5% of the rental payment, G.S. 42-46; deposit clock: 30/60 days, G.S. 42-51/52) run in code before a semantic model pass that must quote the exact flagged words or the flag is dropped. Missing inputs answer "not determinable," never a guess. If the language review fails, the rule-based results are kept and marked partial — a failed check can never look like a pass.
- **Maintenance photo triage:** SAM 3.1 outlines what is visible in a tenant's photo; findings are limited to what the photo supports — no causes, no mold confirmation, no cost estimates. An unreadable photo produces a request for a clearer one instead of findings. The tenant reply is a normal draft through the same check-and-approve flow, and its tone is selectable: Friendly / Firm but fair / Formal.
- **Read-only tenant Q&A:** questions are answered from the one tenant's record only; facts that are not stored answer "not in the record," and questions about a different tenant are refused before any model call. The Q&A code is self-contained and deletable.
- **An append-only audit log:** every generation, check, approval, and question writes a row naming the model that ran, and every row expands to the full stored record — for photo triage, both the interpretation and segmentation models behind the entry. Data access is RLS-scoped to the demo account; direct client writes to drafts and triage are revoked, so every change routes through the server functions that write the audit rows.

## Models and tooling

- All model calls go through one server-side adapter (`src/lib/copilot-model.server.ts`) against the Meta Model API: `muse-spark-1.3` for drafting, the semantic risk pass, photo interpretation, and Q&A phrasing; `sam-3.1` for photo segmentation. A model swap is an environment change, not a code change.
- Built with Lovable on a dedicated Supabase project (separate from the Rentropy production project). Every migration carries scoped GRANTs alongside RLS, per Supabase's Oct 30, 2026 Data API change.

## Honest status

This is a hackathon build on demo data: two demo tenants, no real users, no revenue. The parent product it grows out of is pre-pilot.
