# Rentropy Copilot roadmap

- [x] Build demo app: landlord drafts tenant messages with AI assistance (tenant list, compose + facts used, audit log)
- [x] Create demo_tenants, copilot_drafts, copilot_audit_log with RLS, authenticated-only GRANTs, seeded demo tenants
- [x] One-click demo sign-in
- [x] Switch drafting from Lovable AI Gateway to direct Meta Model API adapter (META_MODEL_* env vars)
- [x] Add META_MODEL_API_KEY, META_MODEL_ID, META_MODEL_API_BASE_URL secrets
- [x] Slice 2: risk check (rule checks + AI language review, span verification, apply rewrites, stale banner, high-flag confirm)
- [x] Slice 3: photo triage (private photo bucket, SAM regions, five-field interpretation, tenant reply draft, work order approve-and-copy)
- [x] Add META_SAM_MODEL_ID value
- [x] Slice 4: read-only tenant Q&A panel (scope check, code answers, verified AI wording, qa audit action)
- [x] Compose flow: English / Spanish draft language (prompt + audit detail, "Draft — Spanish" label)
- [x] Audit log: expandable entries with full stored record, both triage models, linked draft details
