BEGIN;

CREATE OR REPLACE VIEW public.relay_monitor_upstream_balance_credentials
WITH (security_barrier = true) AS
SELECT
  id::text AS source_account_id,
  credentials->>'base_url' AS base_url,
  credentials->>'api_key' AS api_key
FROM public.accounts
WHERE deleted_at IS NULL
  AND status = 'active'
  AND type = 'apikey'
  AND NULLIF(credentials->>'base_url', '') IS NOT NULL
  AND NULLIF(credentials->>'api_key', '') IS NOT NULL;

REVOKE ALL ON public.relay_monitor_upstream_balance_credentials FROM PUBLIC;
GRANT SELECT ON public.relay_monitor_upstream_balance_credentials TO relay_status_monitor_readonly;

COMMIT;
