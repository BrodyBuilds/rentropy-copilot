-- Server functions are the only write path for drafts and photo triage runs;
-- demo_tenants is read-only seed data. SELECT access, the audit log and storage are unchanged.
DROP POLICY IF EXISTS "Demo user can decide pending drafts" ON public.copilot_drafts;
DROP POLICY IF EXISTS "Demo user can update photo triage" ON public.copilot_photo_triage;
REVOKE INSERT, UPDATE ON public.copilot_drafts FROM authenticated;
REVOKE INSERT, UPDATE ON public.copilot_photo_triage FROM authenticated;

DROP POLICY IF EXISTS "Demo user can add tenants" ON public.demo_tenants;
DROP POLICY IF EXISTS "Demo user can edit tenants" ON public.demo_tenants;
REVOKE INSERT, UPDATE ON public.demo_tenants FROM authenticated;