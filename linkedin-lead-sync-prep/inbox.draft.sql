-- DRAFT ONLY. Never apply automatically to production.
-- Isolated inbox; no assumptions about the existing CRM leads table.
-- tenant_id must be sourced from authenticated server context, never request body.
CREATE TABLE IF NOT EXISTS linkedin_lead_sync_inbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(trim(tenant_id)) > 0),
  ad_account_id text NOT NULL CHECK (length(trim(ad_account_id)) > 0),
  response_id text NOT NULL CHECK (length(trim(response_id)) > 0),
  form_id text NOT NULL CHECK (length(trim(form_id)) > 0),
  submitted_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT linkedin_lead_sync_inbox_unique_response
    UNIQUE (tenant_id, ad_account_id, response_id)
);
CREATE INDEX IF NOT EXISTS linkedin_lead_sync_inbox_tenant_received_idx
  ON linkedin_lead_sync_inbox (tenant_id, received_at DESC);
-- Defense in depth: RLS enabled with no policies; default application role
-- must not own table and must be granted an explicit tenant-scoped policy
-- before any application connection is permitted.
ALTER TABLE linkedin_lead_sync_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE linkedin_lead_sync_inbox FORCE ROW LEVEL SECURITY;
-- Intentionally DO NOT grant permissions, create a permissive policy,
-- attach to CRM, or schedule a job until existing auth/tenant architecture is reviewed.
