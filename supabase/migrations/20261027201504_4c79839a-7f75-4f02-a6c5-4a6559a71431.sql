ALTER TABLE public.copilot_audit_log DROP CONSTRAINT IF EXISTS copilot_audit_log_action_check;
ALTER TABLE public.copilot_audit_log ADD CONSTRAINT copilot_audit_log_action_check
  CHECK (action IN ('generate','model_error','approve','discard','risk_check','photo_triage','qa'));