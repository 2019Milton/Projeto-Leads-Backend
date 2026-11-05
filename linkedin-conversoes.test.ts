import { expect, test } from "bun:test";
import {
  aplicarOtimizacaoLeadQualificado,
  campanhaOtimizadaPorLeadQualificado,
  escolherRegraLeadQualificado,
  hashEmailLinkedIn,
  idEventoLinkedIn,
  montarAssociacaoCampanhaConversao,
  montarCorpoRegraLeadQualificado,
  montarEventoConversaoLinkedIn,
  NOME_REGRA_LEAD_QUALIFICADO,
  proximoStartBuscaRegras,
  regraDaConexao,
  urlBuscaRegrasConversao,
  urnRegraConversao,
  urnRespostaFormularioLinkedIn
} from "./linkedin-conversoes";

// SHA-256 calculado fora do código (PowerShell) pra não validar a função contra ela mesma.
const HASH_MARIA = "fe69152db399163076923cac12c437097d25aa4292f8fd32fd82ac309c23eddd";

test("URN da regra de conversão aceita id ou URN e recusa o resto", () => {
  expect(urnRegraConversao("123")).toBe("urn:lla:llaPartnerConversion:123");
  expect(urnRegraConversao(123)).toBe("urn:lla:llaPartnerConversion:123");
  expect(urnRegraConversao(" urn:lla:llaPartnerConversion:77 ")).toBe("urn:lla:llaPartnerConversion:77");
  expect(urnRegraConversao("urn:li:sponsoredCampaign:77")).toBeNull();
  expect(urnRegraConversao("abc")).toBeNull();
  expect(urnRegraConversao("")).toBeNull();
  expect(urnRegraConversao(undefined)).toBeNull();
});

test("corpo da regra: tipo QUALIFIED_LEAD via API, no formato do exemplo oficial", () => {
  expect(montarCorpoRegraLeadQualificado("559746166")).toEqual({
    name: NOME_REGRA_LEAD_QUALIFICADO,
    account: "urn:li:sponsoredAccount:559746166",
    conversionMethod: "CONVERSIONS_API",
    type: "QUALIFIED_LEAD",
    postClickAttributionWindowSize: 90,
    viewThroughAttributionWindowSize: 30,
    attributionType: "LAST_TOUCH_BY_CAMPAIGN"
  });
  expect(() => montarCorpoRegraLeadQualificado("abc")).toThrow();
  expect(() => montarCorpoRegraLeadQualificado("")).toThrow();
});

test("busca de regras: só o ':' do URN vai codificado", () => {
  expect(urlBuscaRegrasConversao("559746166")).toBe(
    "/conversions?q=account&account=urn%3Ali%3AsponsoredAccount%3A559746166"
  );
  expect(urlBuscaRegrasConversao("559746166", 10)).toBe(
    "/conversions?q=account&account=urn%3Ali%3AsponsoredAccount%3A559746166&start=10"
  );
  expect(() => urlBuscaRegrasConversao("1; DROP")).toThrow();
});

test("paginação da busca só avança quando a resposta diz que tem mais", () => {
  expect(proximoStartBuscaRegras({ elements: [{ id: 1 }] })).toBeNull();
  expect(proximoStartBuscaRegras({ elements: [], paging: { total: 5, start: 0 } })).toBeNull();
  expect(proximoStartBuscaRegras({ elements: [{ id: 1 }, { id: 2 }], paging: { total: 2, start: 0 } })).toBeNull();
  expect(proximoStartBuscaRegras({ elements: [{ id: 1 }, { id: 2 }], paging: { total: 5, start: 0 } })).toBe(2);
  expect(proximoStartBuscaRegras({ elements: [{ id: 3 }], paging: { total: 5, start: 2 } })).toBe(3);
  expect(proximoStartBuscaRegras(null)).toBeNull();
});

test("reaproveita a regra certa: ativa, da conta, via API, QUALIFIED_LEAD", () => {
  const regra = (extra: any) => ({
    id: 100, type: "QUALIFIED_LEAD", conversionMethod: "CONVERSIONS_API", enabled: true, ownershipType: "OWNED", name: "Outra", ...extra
  });
  expect(escolherRegraLeadQualificado([])).toBeNull();
  expect(escolherRegraLeadQualificado(undefined)).toBeNull();
  expect(escolherRegraLeadQualificado([regra({ type: "LEAD" })])).toBeNull();
  expect(escolherRegraLeadQualificado([regra({ conversionMethod: "INSIGHT_TAG" })])).toBeNull();
  expect(escolherRegraLeadQualificado([regra({ enabled: false })])).toBeNull();
  expect(escolherRegraLeadQualificado([regra({ ownershipType: "SHARED" })])).toBeNull();
  expect(escolherRegraLeadQualificado([regra({ id: "x" })])).toBeNull();
  expect(escolherRegraLeadQualificado([regra({})])).toBe("urn:lla:llaPartnerConversion:100");
  // sem campo ownershipType (versões antigas) ainda vale
  expect(escolherRegraLeadQualificado([regra({ ownershipType: undefined })])).toBe("urn:lla:llaPartnerConversion:100");
  // prefere o nome da plataforma; no empate de nome, o menor id
  expect(
    escolherRegraLeadQualificado([regra({ id: 5 }), regra({ id: 9, name: NOME_REGRA_LEAD_QUALIFICADO })])
  ).toBe("urn:lla:llaPartnerConversion:9");
  expect(escolherRegraLeadQualificado([regra({ id: 9 }), regra({ id: 5 })])).toBe("urn:lla:llaPartnerConversion:5");
});

test("associação campanha-regra: mesmo formato do exemplo oficial", () => {
  const { url, body } = montarAssociacaoCampanhaConversao("337643194", "70203");
  expect(url).toBe(
    "/campaignConversions/(campaign:urn%3Ali%3AsponsoredCampaign%3A337643194,conversion:urn%3Alla%3AllaPartnerConversion%3A70203)"
  );
  expect(body).toEqual({
    campaign: "urn:li:sponsoredCampaign:337643194",
    conversion: "urn:lla:llaPartnerConversion:70203"
  });
  expect(() => montarAssociacaoCampanhaConversao("abc", "70203")).toThrow();
  expect(() => montarAssociacaoCampanhaConversao("1", "urn:li:foo:1")).toThrow();
});

test("regra da conexão só vale pra conta de anúncios atual", () => {
  const dados = {
    ad_account_id: "111",
    conversion_rule_qualified_urn: "urn:lla:llaPartnerConversion:5",
    conversion_rule_qualified_conta_id: "111",
    conversion_rule_closed_urn: "9"
  };
  expect(regraDaConexao(dados, "Qualified Lead")).toBe("urn:lla:llaPartnerConversion:5");
  // trocou de conta: a regra antiga é de outra conta
  expect(regraDaConexao({ ...dados, ad_account_id: "222" }, "Qualified Lead")).toBeNull();
  // URN manual antigo, sem conta registrada, continua valendo
  expect(regraDaConexao(dados, "Closed Won")).toBe("urn:lla:llaPartnerConversion:9");
  expect(regraDaConexao({ ...dados, conversion_rule_closed_conta_id: "999" }, "Closed Won")).toBeNull();
  expect(regraDaConexao({ ad_account_id: "111" }, "Qualified Lead")).toBeNull();
  expect(regraDaConexao(null, "Qualified Lead")).toBeNull();
  expect(regraDaConexao({ ...dados, conversion_rule_qualified_urn: "lixo" }, "Qualified Lead")).toBeNull();
});

test("URN da resposta do formulário vem do lead_id; fallback do importador não vira URN", () => {
  expect(urnRespostaFormularioLinkedIn("8f7356abcd9-8d5c-49ca-931b-513123abc9-4")).toBe(
    "urn:li:leadGenFormResponse:8f7356abcd9-8d5c-49ca-931b-513123abc9-4"
  );
  expect(urnRespostaFormularioLinkedIn("urn:li:leadGenFormResponse:abc12345")).toBe("urn:li:leadGenFormResponse:abc12345");
  // formato "<formId>-<submittedAt>" do importador quando a resposta vem sem id
  expect(urnRespostaFormularioLinkedIn("1026108109-1790000000000")).toBeNull();
  expect(urnRespostaFormularioLinkedIn("123")).toBeNull();
  expect(urnRespostaFormularioLinkedIn("")).toBeNull();
  expect(urnRespostaFormularioLinkedIn(null)).toBeNull();
  expect(urnRespostaFormularioLinkedIn("a b c d e f g h")).toBeNull();
});

test("hash do e-mail: minúsculas, sem espaços, SHA-256 em hex", () => {
  expect(hashEmailLinkedIn("maria.silva@exemplo.com.br")).toBe(HASH_MARIA);
  expect(hashEmailLinkedIn("  Maria.Silva@Exemplo.com.br ")).toBe(HASH_MARIA);
  expect(hashEmailLinkedIn("sem-arroba")).toBeNull();
  expect(hashEmailLinkedIn("")).toBeNull();
  expect(hashEmailLinkedIn(null)).toBeNull();
});

test("id do evento continua o mesmo de antes (idempotência)", () => {
  expect(idEventoLinkedIn(42, "Qualified Lead")).toBe("lead-42-qualified-lead");
  expect(idEventoLinkedIn(42, "Closed Won")).toBe("lead-42-closed-won");
});

test("evento: e-mail com hash + URN do formulário; sem valor não manda conversionValue", () => {
  const evento = montarEventoConversaoLinkedIn({
    regraUrn: "5",
    lead: { id: 42, plataforma: "linkedin", lead_id: "8f7356abcd9-8d5c-49ca-931b-513123abc9-4", email: "Maria.Silva@exemplo.com.br" },
    etapa: "Qualified Lead",
    agoraMs: 1_790_000_000_000
  });
  expect(evento).toEqual({
    conversion: "urn:lla:llaPartnerConversion:5",
    conversionHappenedAt: 1_790_000_000_000,
    user: {
      userIds: [{ idType: "SHA256_EMAIL", idValue: HASH_MARIA }],
      lead: "urn:li:leadGenFormResponse:8f7356abcd9-8d5c-49ca-931b-513123abc9-4"
    },
    eventId: "lead-42-qualified-lead"
  });
});

test("evento: valor da venda só quando positivo, com moeda", () => {
  const base = { regraUrn: "5", lead: { id: 1, email: "a@b.com" }, etapa: "Closed Won" as const, agoraMs: 1 };
  expect(montarEventoConversaoLinkedIn({ ...base, valor: 2500.5, moeda: "BRL" })?.conversionValue).toEqual({
    currencyCode: "BRL",
    amount: "2500.50"
  });
  expect(montarEventoConversaoLinkedIn({ ...base, valor: 0 })?.conversionValue).toBeUndefined();
  expect(montarEventoConversaoLinkedIn({ ...base, valor: null })?.conversionValue).toBeUndefined();
  expect(montarEventoConversaoLinkedIn({ ...base, valor: -3 })?.conversionValue).toBeUndefined();
  expect(montarEventoConversaoLinkedIn({ ...base, valor: 10 })?.conversionValue?.currencyCode).toBe("BRL");
});

test("evento: sem e-mail mas com URN do formulário manda userIds vazio; sem nada, não manda", () => {
  const semEmail = montarEventoConversaoLinkedIn({
    regraUrn: "5",
    lead: { id: 7, plataforma: "linkedin", lead_id: "abcd1234-efgh", email: "" },
    etapa: "Qualified Lead",
    agoraMs: 1
  });
  expect(semEmail?.user).toEqual({ userIds: [], lead: "urn:li:leadGenFormResponse:abcd1234-efgh" });

  expect(montarEventoConversaoLinkedIn({ regraUrn: "5", lead: { id: 7, plataforma: "linkedin", email: "" }, etapa: "Qualified Lead" })).toBeNull();
  // lead vindo do WhatsApp não tem resposta de formulário: o lead_id dele não vira URN
  expect(
    montarEventoConversaoLinkedIn({ regraUrn: "5", lead: { id: 7, plataforma: "whatsapp", lead_id: "abcd1234-efgh" }, etapa: "Qualified Lead" })
  ).toBeNull();
  expect(() => montarEventoConversaoLinkedIn({ regraUrn: "lixo", lead: { id: 1, email: "a@b.com" }, etapa: "Qualified Lead" })).toThrow();
});

test("evento não leva nome, telefone nem IP (só o necessário pra casar)", () => {
  const evento = montarEventoConversaoLinkedIn({
    regraUrn: "5",
    lead: { id: 1, nome: "Maria Silva", telefone: "11999999999", email: "a@b.com", atribuicao: { ip: "1.2.3.4" } },
    etapa: "Qualified Lead",
    agoraMs: 1
  });
  const texto = JSON.stringify(evento);
  expect(texto).not.toContain("Maria");
  expect(texto).not.toContain("11999999999");
  expect(texto).not.toContain("1.2.3.4");
  expect(texto).not.toContain("a@b.com");
});

test("otimização por lead qualificado: lance automático, sem unitCost, e nunca muda o original", () => {
  const original = {
    objectiveType: "LEAD_GENERATION",
    costType: "CPC",
    unitCost: { amount: "5.00", currencyCode: "BRL" },
    dailyBudget: { amount: "20.00", currencyCode: "BRL" },
    status: "DRAFT"
  };
  const copia = JSON.parse(JSON.stringify(original));
  const otimizado = aplicarOtimizacaoLeadQualificado(original);

  expect(original).toEqual(copia); // não mexeu no objeto recebido
  expect(otimizado.costType).toBe("CPM");
  expect(otimizado.optimizationTargetType).toBe("MAX_QUALIFIED_LEAD");
  expect("unitCost" in otimizado).toBe(false);
  expect(otimizado.dailyBudget).toEqual(original.dailyBudget);
  expect(otimizado.status).toBe("DRAFT");
  expect(campanhaOtimizadaPorLeadQualificado(otimizado)).toBe(true);
  expect(campanhaOtimizadaPorLeadQualificado(original)).toBe(false);
});

test("payload real de /linkedin/adgroup só troca lance e otimização — o resto fica idêntico", () => {
  const real = {
    account: "urn:li:sponsoredAccount:559746166",
    campaignGroup: "urn:li:sponsoredCampaignGroup:1225188443",
    associatedEntity: "urn:li:organization:144976037",
    name: "Campaign Leads 1790000000000",
    type: "SPONSORED_UPDATES",
    objectiveType: "LEAD_GENERATION",
    costType: "CPC",
    audienceExpansionEnabled: false,
    connectedTelevisionOnly: false,
    creativeSelection: "OPTIMIZED",
    offsiteDeliveryEnabled: false,
    politicalIntent: "NOT_POLITICAL",
    unitCost: { amount: "5.00", currencyCode: "BRL" },
    dailyBudget: { amount: "20.00", currencyCode: "BRL" },
    locale: { country: "BR", language: "pt" },
    runSchedule: { start: 1_790_000_000_000 },
    targetingCriteria: { include: { and: [{ or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:106057199"] } }] } },
    status: "DRAFT"
  };
  const otimizado = aplicarOtimizacaoLeadQualificado(real);
  const { unitCost: _removido, costType: _antigo, ...restoOriginal } = real;
  const { optimizationTargetType, costType, ...restoOtimizado } = otimizado as any;

  expect(restoOtimizado).toEqual(restoOriginal);
  expect(optimizationTargetType).toBe("MAX_QUALIFIED_LEAD");
  expect(costType).toBe("CPM");
  expect(otimizado.status).toBe("DRAFT"); // continua rascunho: nada é ativado
});

test("otimização por lead qualificado não se aplica a outro objetivo (ex.: destino WhatsApp)", () => {
  const whatsapp = { objectiveType: "WEBSITE_VISIT", costType: "CPC", unitCost: { amount: "5.00", currencyCode: "BRL" } };
  const resultado = aplicarOtimizacaoLeadQualificado(whatsapp);
  expect(resultado).toEqual(whatsapp);
  expect(resultado).not.toBe(whatsapp);
  expect(campanhaOtimizadaPorLeadQualificado(resultado)).toBe(false);
});
