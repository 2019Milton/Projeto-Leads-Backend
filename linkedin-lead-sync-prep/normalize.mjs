/**
 * Offline-only adapter for simulated LinkedIn lead responses.
 * Inputs use an internal normalized contract, NOT LinkedIn's HTTP API schema.
 * No network, database, or campaign mutations.
 */
export function normalizeLeadResponse(input) {
  if (!input || typeof input !== 'object') throw new TypeError('response must be an object');
  const { responseId, formId, accountId, submittedAt, answers } = input;
  for (const [name, value] of Object.entries({responseId, formId, accountId})) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  }
  if (!Array.isArray(answers)) throw new TypeError('answers must be an array');
  const date = new Date(submittedAt);
  if (!submittedAt || Number.isNaN(date.getTime())) throw new TypeError('submittedAt must be valid');
  const fields = {};
  for (const answer of answers) {
    if (!answer || typeof answer.key !== 'string' || !answer.key.trim() || typeof answer.value !== 'string') {
      throw new TypeError('invalid answer');
    }
    if (Object.hasOwn(fields, answer.key)) throw new TypeError('duplicate answer key');
    fields[answer.key] = answer.value;
  }
  return Object.freeze({
    provider: 'linkedin',
    externalId: responseId.trim(),
    externalFormId: formId.trim(),
    externalAccountId: accountId.trim(),
    submittedAt: date.toISOString(),
    fields: Object.freeze(fields),
  });
}
/** Offline duplicate simulation only. Real writes require a tenant-scoped DB unique
 * constraint and an atomic UPSERT; this function does not persist anything.
 */
export function simulateImport(responses) {
  if (!Array.isArray(responses)) throw new TypeError('responses must be an array');
  const seen = new Set();
  const inserted = [];
  let duplicates = 0;
  for (const response of responses) {
    const normalized = normalizeLeadResponse(response);
    const key = JSON.stringify([normalized.provider, normalized.externalAccountId, normalized.externalId]);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    inserted.push(normalized);
  }
  return { inserted, duplicates };
}
