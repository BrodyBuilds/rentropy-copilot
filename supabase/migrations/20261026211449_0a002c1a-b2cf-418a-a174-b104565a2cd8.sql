-- Slice 3: photo triage
CREATE TABLE public.copilot_photo_triage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.demo_tenants(id) ON DELETE CASCADE,
  photo_path text NOT NULL,
  concept_prompt text NOT NULL,
  segmentation jsonb,
  findings jsonb,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','completed','needs_clearer_photo','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX copilot_photo_triage_created_idx ON public.copilot_photo_triage (created_at DESC);
GRANT SELECT, INSERT, UPDATE ON public.copilot_photo_triage TO authenticated;
GRANT ALL ON public.copilot_photo_triage TO service_role;
ALTER TABLE public.copilot_photo_triage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Demo user can read photo triage" ON public.copilot_photo_triage
  FOR SELECT TO authenticated USING (public.is_demo_user());
CREATE POLICY "Demo user can create photo triage" ON public.copilot_photo_triage
  FOR INSERT TO authenticated WITH CHECK (public.is_demo_user());
CREATE POLICY "Demo user can update photo triage" ON public.copilot_photo_triage
  FOR UPDATE TO authenticated USING (public.is_demo_user()) WITH CHECK (public.is_demo_user());

-- Audit: allow the photo_triage action
ALTER TABLE public.copilot_audit_log DROP CONSTRAINT IF EXISTS copilot_audit_log_action_check;
ALTER TABLE public.copilot_audit_log ADD CONSTRAINT copilot_audit_log_action_check
  CHECK (action IN ('generate','model_error','approve','discard','risk_check','photo_triage'));

-- Private maintenance-photos bucket: signed-in demo user may upload and read there only; anon gets nothing
CREATE POLICY "Demo user can upload maintenance photos" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'maintenance-photos' AND public.is_demo_user());
CREATE POLICY "Demo user can read maintenance photos" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'maintenance-photos' AND public.is_demo_user());