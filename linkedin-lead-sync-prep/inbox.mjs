import { normalizeLeadResponse } from './normalize.mjs';

/**
 * Optional, never called by production routes.
 * Caller must supply tenantId from verified server-side auth context.
 * db must be a tenant-restricted SQL client; no dynamic SQL.
 * SQL migration deliberately remains a draft pending schema/security review.
 */
export async function storeSimulatedLead(db, tenantId, input) {
  if (typeof tenantId !== 'string' || !tenantId.trim()) throw new TypeError('trusted tenantId is required');
  if (!db || typeof db.query !== 'function') throw new TypeError('database client required');
  const lead = normalizeLeadResponse(input);
  const sql = `INSERT INTO linkedin_lead_sync_inbox
    (tenant_id, ad_account_id, response_id, form_id, submitted_at, payload)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    ON CONFLICT (tenant_id, ad_account_id, response_id) DO NOTHING
    RETURNING id`;
  const params = [tenantId.trim(), lead.externalAccountId, lead.externalId, lead.externalFormId,
    lead.submittedAt, JSON.stringify(lead.fields)];
  const result = await db.query(sql, params);
  return { inserted: (result.rowCount ?? result.rows?.length ?? 0) > 0 };
}
