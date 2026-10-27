import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { criarDesafioLinkedIn, verificarAssinaturaLinkedIn, lerNotificacaoLinkedIn } from "./linkedin-webhook-security.mjs";

const secret = "test-client-secret-do-not-use";
const raw = '{"type":"LEAD_ACTION","leadAction":"CREATED"}';

test("challengeCode recebe resposta HMAC SHA256 padrão LinkedIn", () => {
  const code = "11111111-2222-4333-8444-555555555555";
  assert.deepEqual(criarDesafioLinkedIn(code, secret), {
    challengeCode: code,
    challengeResponse: createHmac("sha256", secret).update(code).digest("hex")
  });
});
test("POST usa HMAC do corpo bruto, rejeitando adulteração e assinatura ausente", () => {
  const signature = createHmac("sha256", secret).update("hmacsha256=" + raw).digest("hex");
  assert.equal(verificarAssinaturaLinkedIn(raw, signature, secret), true);
  assert.equal(verificarAssinaturaLinkedIn(raw + " ", signature, secret), false);
  assert.equal(verificarAssinaturaLinkedIn(raw, "", secret), false);
  assert.equal(verificarAssinaturaLinkedIn(raw, "0".repeat(64), secret), false);
  assert.equal(verificarAssinaturaLinkedIn(raw, signature, ""), false);
});
test("notificações não são confundidas com respostas completas", () => {
  const notification = {type:"LEAD_ACTION",leadType:"SPONSORED",leadAction:"CREATED",
    leadGenFormResponse:"urn:li:leadGenFormResponse:abc-12",
    owner:{sponsoredAccount:"urn:li:sponsoredAccount:1234"}, occurredAt:1720000000000};
  assert.deepEqual(lerNotificacaoLinkedIn(notification),{
    accountId:"1234",responseUrn:notification.leadGenFormResponse,
    action:"CREATED",occurredAt:notification.occurredAt
  });
  assert.equal(lerNotificacaoLinkedIn({...notification,owner:{organization:"urn:li:organization:1"}}),null);
  assert.equal(lerNotificacaoLinkedIn({...notification,leadAction:"UNKNOWN"}),null);
  assert.equal(lerNotificacaoLinkedIn({formResponse:{answers:[]}}),null);
});
test("route permanece fechada sem Lead Sync e não confia em Bearer", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const section = source.match(/app\.get\("\/webhook\/linkedin",[\s\S]*?(?=\/\* =========================\s*🎬 WEBHOOK KWAI)/)?.[0];
  assert.ok(section,"webhook LinkedIn não encontrado");
  assert.match(section,/LINKEDIN_LEAD_SYNC_HABILITADO/);
  assert.match(section,/x-li-signature/i);
  assert.match(section,/criarDesafioLinkedIn/);
  assert.match(section,/verificarAssinaturaLinkedIn/);
  assert.doesNotMatch(section,/authorization.*Bearer/i);
  assert.doesNotMatch(section,/processarLeadGenFormResponseLinkedIn/);
});
