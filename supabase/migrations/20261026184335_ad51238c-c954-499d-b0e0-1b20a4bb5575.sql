-- Helper: is the caller the signed-in demo account? (app_metadata is only settable server-side)
CREATE OR REPLACE FUNCTION public.is_demo_user()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce((auth.jwt() -> 'app_metadata' ->> 'demo') = 'true', false)
$$;
REVOKE ALL ON FUNCTION public.is_demo_user() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_demo_user() TO authenticated, service_role;

-- 1. demo_tenants
CREATE TABLE public.demo_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  property_label text NOT NULL,
  lease_start date NOT NULL,
  lease_end date NOT NULL,
  rent_cents integer NOT NULL,
  due_day integer NOT NULL,
  balance_cents integer NOT NULL DEFAULT 0,
  lease_late_fee_cents integer NOT NULL DEFAULT 0,
  deposit_status text NOT NULL,
  termination_date date,
  possession_date date,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.demo_tenants TO authenticated;
GRANT ALL ON public.demo_tenants TO service_role;
ALTER TABLE public.demo_tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Demo user can read tenants" ON public.demo_tenants
  FOR SELECT TO authenticated USING (public.is_demo_user());
CREATE POLICY "Demo user can add tenants" ON public.demo_tenants
  FOR INSERT TO authenticated WITH CHECK (public.is_demo_user());
CREATE POLICY "Demo user can edit tenants" ON public.demo_tenants
  FOR UPDATE TO authenticated USING (public.is_demo_user()) WITH CHECK (public.is_demo_user());

-- 2. copilot_drafts
CREATE TABLE public.copilot_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.demo_tenants(id) ON DELETE CASCADE,
  message_type text NOT NULL CHECK (message_type IN ('late_rent','renewal','maintenance_update','deposit_reply','move_notice')),
  tone text NOT NULL CHECK (tone IN ('friendly','firm_but_fair','formal')),
  draft_body text NOT NULL,
  risk_flags jsonb,
  risk_checked_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','discarded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid
);
CREATE INDEX copilot_drafts_tenant_idx ON public.copilot_drafts (tenant_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON public.copilot_drafts TO authenticated;
GRANT ALL ON public.copilot_drafts TO service_role;
ALTER TABLE public.copilot_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Demo user can read drafts" ON public.copilot_drafts
  FOR SELECT TO authenticated USING (public.is_demo_user());
CREATE POLICY "Demo user can create pending drafts" ON public.copilot_drafts
  FOR INSERT TO authenticated WITH CHECK (public.is_demo_user() AND status = 'pending');
CREATE POLICY "Demo user can decide pending drafts" ON public.copilot_drafts
  FOR UPDATE TO authenticated
  USING (public.is_demo_user() AND status = 'pending')
  WITH CHECK (public.is_demo_user());

-- 3. copilot_audit_log (append-only for the app role)
CREATE TABLE public.copilot_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid REFERENCES public.copilot_drafts(id) ON DELETE SET NULL,
  tenant_id uuid REFERENCES public.demo_tenants(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('generate','model_error','approve','discard')),
  model_id text,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX copilot_audit_log_created_idx ON public.copilot_audit_log (created_at);
GRANT SELECT, INSERT ON public.copilot_audit_log TO authenticated;
GRANT ALL ON public.copilot_audit_log TO service_role;
ALTER TABLE public.copilot_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Demo user can read audit log" ON public.copilot_audit_log
  FOR SELECT TO authenticated USING (public.is_demo_user());
CREATE POLICY "Demo user can append audit rows" ON public.copilot_audit_log
  FOR INSERT TO authenticated WITH CHECK (public.is_demo_user());

-- Seed: locked demo facts
INSERT INTO public.demo_tenants
  (full_name, property_label, lease_start, lease_end, rent_cents, due_day, balance_cents, lease_late_fee_cents, deposit_status, termination_date, possession_date)
VALUES
  ('Sarah Jenkins', 'The Heights', '2026-03-01', '2027-02-28', 245000, 1, 245000, 12250, 'held', NULL, NULL),
  ('James Carter', 'Maple Ridge', '2026-05-01', '2027-04-30', 185000, 1, 0, 9250, 'disputed', NULL, NULL);