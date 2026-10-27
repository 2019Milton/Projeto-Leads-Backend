import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Pure LinkedIn webhook security helpers.
 * https://learn.microsoft.com/en-us/linkedin/shared/api-guide/webhook-validation
 */
export function criarDesafioLinkedIn(challengeCode, clientSecret) {
  if (typeof challengeCode !== "string" || !challengeCode.trim() ||
      typeof clientSecret !== "string" || !clientSecret) {
    throw new TypeError("challengeCode e clientSecret obrigatórios");
  }
  return {
    challengeCode,
    challengeResponse: createHmac("sha256", clientSecret).update(challengeCode, "utf8").digest("hex"),
  };
}

export function verificarAssinaturaLinkedIn(rawBody, signature, clientSecret) {
  if (typeof rawBody !== "string" ||
      typeof signature !== "string" ||
      !/^[0-9a-f]{64}$/i.test(signature) ||
      typeof clientSecret !== "string" || !clientSecret) return false;
  // LinkedIn signs the exact bytes of 'hmacsha256=' plus the raw request body.
  const expected = createHmac("sha256", clientSecret)
    .update("hmacsha256=" + rawBody, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

/** Validate notification envelope; do NOT treat it as a lead-form response. */
export function lerNotificacaoLinkedIn(input) {
  if (!input || Array.isArray(input) || typeof input !== "object" ||
      input.type !== "LEAD_ACTION" ||
      input.leadType !== "SPONSORED" ||
      !["CREATED", "DELETED"].includes(input.leadAction) ||
      typeof input.leadGenFormResponse !== "string" ||
      !/^urn:li:leadGenFormResponse:[^\s]+$/.test(input.leadGenFormResponse) ||
      typeof input.owner?.sponsoredAccount !== "string" ||
      !/^urn:li:sponsoredAccount:\d+$/.test(input.owner.sponsoredAccount) ||
      !Number.isFinite(input.occurredAt)) return null;
  return {
    accountId: input.owner.sponsoredAccount.split(":").pop(),
    responseUrn: input.leadGenFormResponse,
    action: input.leadAction,
    occurredAt: input.occurredAt,
  };
}
