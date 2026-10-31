-- Tenant voice notes: private bucket "tenant-voice-notes" (created as private, no public access).
-- Owner-scoped: a signed-in demo user may upload and read only files under their own
-- user-id folder; no update or delete, so a stored voice note stays on the record.
-- anon gets nothing (no policies for anon).
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass) THEN
    RAISE EXCEPTION 'Row level security must be enabled on storage.objects';
  END IF;
END $$;

GRANT SELECT, INSERT ON storage.objects TO authenticated;

CREATE POLICY "Demo user can upload own tenant voice notes" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'tenant-voice-notes'
    AND public.is_demo_user()
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );

CREATE POLICY "Demo user can read own tenant voice notes" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'tenant-voice-notes'
    AND public.is_demo_user()
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );

-- Audit: allow the voice_transcribe action alongside the existing values
ALTER TABLE public.copilot_audit_log DROP CONSTRAINT IF EXISTS copilot_audit_log_action_check;
ALTER TABLE public.copilot_audit_log ADD CONSTRAINT copilot_audit_log_action_check
  CHECK (action IN ('generate','model_error','approve','discard','risk_check','photo_triage','qa','approved_after_partial_review','voice_transcribe'));