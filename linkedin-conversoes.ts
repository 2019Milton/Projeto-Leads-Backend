// Leads qualificados do CRM de volta ao LinkedIn (Conversions API) para o
// LinkedIn otimizar a entrega por lead qualificado ("Qualified leads"
// optimization goal). Só funções puras (montam payloads e escolhem dados) —
// nenhuma chamada de rede aqui; as rotas em index.ts fazem o I/O e estão
// atrás de variáveis de ambiente (ver LINKEDIN-CONVERSOES.md).
//
// Fonte (Microsoft Learn, LinkedIn Marketing API):
// - integrations/ads-reporting/conversions-api e conversions-api-schema
// - conversions/conversions-usecase (caso 5: Qualified Leads Optimization Goal)
// - integrations/ads/account-structure/create-and-manage-campaigns
//   (optimizationTargetType MAX_QUALIFIED_LEAD, API >= 202602)
//
// Fluxo oficial: 1) criar a Conversion Rule (POST /conversions, type
// QUALIFIED_LEAD, conversionMethod CONVERSIONS_API); 2) associar a campanha à
// regra (PUT /campaignConversions) — a auto-associação por objetivo só pega
// campanha que JÁ usa MAX_QUALIFIED_LEAD; 3) mandar os eventos
// (POST /conversionEvents) em até 30 dias pra entrar na otimização.

import { createHash } from "node:crypto";

export type EtapaLinkedIn = "Qualified Lead" | "Closed Won";

export const NOME_REGRA_LEAD_QUALIFICADO = "Plataforma de Leads - Lead qualificado";
export const OTIMIZACAO_LEAD_QUALIFICADO = "MAX_QUALIFIED_LEAD";

// A regra de conversão tem um URN próprio (urn:lla:llaPartnerConversion:<id>),
// diferente de todos os outros URNs do LinkedIn. Aceita o id puro ou o URN.
export function urnRegraConversao(valor: unknown): string | null {
  const texto = String(valor ?? "").trim();
  if (/^urn:lla:llaPartnerConversion:\d+$/.test(texto)) return texto;
  if (/^\d+$/.test(texto)) return `urn:lla:llaPartnerConversion:${texto}`;
  return null;
}

function idNumerico(valor: unknown, nome: string): string {
  const texto = String(valor ?? "").trim();
  if (!/^\d+$/.test(texto)) throw new Error(`${nome} inválido`);
  return texto;
}

// Corpo do POST /conversions. 90 dias de clique e 30 de visualização são os
// valores do exemplo oficial; QUALIFIED_LEAD aceita até 365.
export function montarCorpoRegraLeadQualificado(adAccountId: unknown) {
  return {
    name: NOME_REGRA_LEAD_QUALIFICADO,
    account: `urn:li:sponsoredAccount:${idNumerico(adAccountId, "adAccountId")}`,
    conversionMethod: "CONVERSIONS_API",
    type: "QUALIFIED_LEAD",
    postClickAttributionWindowSize: 90,
    viewThroughAttributionWindowSize: 30,
    attributionType: "LAST_TOUCH_BY_CAMPAIGN"
  };
}

// GET /conversions?q=account&account=<urn codificado> (formato do exemplo
// oficial: só os ":" do URN vão codificados).
export function urlBuscaRegrasConversao(adAccountId: unknown, start?: number): string {
  const urn = `urn:li:sponsoredAccount:${idNumerico(adAccountId, "adAccountId")}`;
  const base = `/conversions?q=account&account=${encodeURIComponent(urn)}`;
  return start && start > 0 ? `${base}&start=${start}` : base;
}

// A busca oficial não documenta paginação. Só pede a próxima página se a
// própria resposta disser que tem mais.
export function proximoStartBuscaRegras(data: any): number | null {
  const elementos = Array.isArray(data?.elements) ? data.elements.length : 0;
  const total = Number(data?.paging?.total);
  const inicio = Number(data?.paging?.start ?? 0);
  if (!elementos || !Number.isFinite(total)) return null;
  const proximo = inicio + elementos;
  return proximo < total ? proximo : null;
}

// Reaproveita a regra já criada (a rota é chamada mais de uma vez): ativa,
// da própria conta, via API e do tipo QUALIFIED_LEAD. Prefere o nome da
// plataforma; no empate, o menor id (determinístico).
export function escolherRegraLeadQualificado(elementos: unknown): string | null {
  if (!Array.isArray(elementos)) return null;
  const candidatas = elementos
    .filter((el: any) =>
      el?.type === "QUALIFIED_LEAD" &&
      el?.conversionMethod === "CONVERSIONS_API" &&
      el?.enabled !== false &&
      (el?.ownershipType === undefined || el?.ownershipType === "OWNED") &&
      urnRegraConversao(el?.id) !== null
    )
    .sort((a: any, b: any) => {
      const nomeA = a.name === NOME_REGRA_LEAD_QUALIFICADO ? 0 : 1;
      const nomeB = b.name === NOME_REGRA_LEAD_QUALIFICADO ? 0 : 1;
      return nomeA - nomeB || Number(a.id) - Number(b.id);
    });
  return candidatas.length ? urnRegraConversao(candidatas[0].id) : null;
}

// PUT /campaignConversions/(campaign:<urn>,conversion:<urn>) — chave composta
// no formato do exemplo oficial; corpo com os dois URNs.
export function montarAssociacaoCampanhaConversao(campaignId: unknown, conversaoUrn: string) {
  const regra = urnRegraConversao(conversaoUrn);
  if (!regra) throw new Error("URN da regra de conversão inválido");
  const campanhaUrn = `urn:li:sponsoredCampaign:${idNumerico(campaignId, "campaignId")}`;
  return {
    url: `/campaignConversions/(campaign:${encodeURIComponent(campanhaUrn)},conversion:${encodeURIComponent(regra)})`,
    body: { campaign: campanhaUrn, conversion: regra }
  };
}

// Regra guardada na conexão, valendo só pra conta de anúncios atual: a regra
// pertence a UMA conta, e /linkedin/selecionar-conta troca a conta sem apagar
// os campos antigos. URN manual antigo (sem conta registrada) continua valendo.
export function regraDaConexao(dadosConta: any, etapa: EtapaLinkedIn): string | null {
  const chave = etapa === "Qualified Lead" ? "conversion_rule_qualified" : "conversion_rule_closed";
  const urn = urnRegraConversao(dadosConta?.[`${chave}_urn`]);
  if (!urn) return null;
  const contaDaRegra = String(dadosConta?.[`${chave}_conta_id`] ?? "").trim();
  const contaAtual = String(dadosConta?.ad_account_id ?? "").trim();
  if (contaDaRegra && contaDaRegra !== contaAtual) return null;
  return urn;
}

// O importador de leads (processarLeadGenFormResponseLinkedIn) guarda em
// leads.lead_id o id da resposta do Lead Gen Form; o URN que a Conversions
// API pede é urn:li:leadGenFormResponse:<id>. Quando a resposta vem sem id o
// importador cai no formato "<formId>-<submittedAt>", que não é um id da
// resposta — esse não vira URN.
export function urnRespostaFormularioLinkedIn(leadId: unknown): string | null {
  const texto = String(leadId ?? "").trim();
  if (!texto) return null;
  if (/^urn:li:leadGenFormResponse:[A-Za-z0-9_-]+$/.test(texto)) return texto;
  if (/^\d+-\d{9,}$/.test(texto)) return null;
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{7,}$/.test(texto)) return `urn:li:leadGenFormResponse:${texto}`;
  return null;
}

// SHA256_EMAIL: minúsculas, sem nenhum espaço, SHA-256 em hex (doc oficial).
export function hashEmailLinkedIn(email: unknown): string | null {
  const limpo = String(email ?? "").replace(/\s+/g, "").toLowerCase();
  if (!limpo.includes("@")) return null;
  return createHash("sha256").update(limpo).digest("hex");
}

// Mesmo id de antes (idempotência: o LinkedIn descarta o evento repetido).
export function idEventoLinkedIn(leadId: unknown, etapa: EtapaLinkedIn): string {
  return `lead-${leadId}-${etapa.replace(/\s+/g, "-").toLowerCase()}`;
}

// Corpo do POST /conversionEvents. Só identificadores que o LinkedIn aceita:
// e-mail com hash e/ou o URN da resposta do formulário. Sem nome em texto
// puro, telefone nem IP — não manda dado pessoal além do necessário pra casar.
// Sem nenhum identificador devolve null (não há como casar com o perfil).
export function montarEventoConversaoLinkedIn(params: {
  regraUrn: string;
  lead: any;
  etapa: EtapaLinkedIn;
  valor?: number | null;
  moeda?: string;
  agoraMs?: number;
}): Record<string, any> | null {
  const regra = urnRegraConversao(params.regraUrn);
  if (!regra) throw new Error("URN da regra de conversão inválido");

  const { lead, etapa } = params;
  const hash = hashEmailLinkedIn(lead?.email);
  const urnLead = lead?.plataforma === "linkedin" ? urnRespostaFormularioLinkedIn(lead?.lead_id) : null;
  if (!hash && !urnLead) return null;

  const user: Record<string, any> = {
    userIds: hash ? [{ idType: "SHA256_EMAIL", idValue: hash }] : []
  };
  if (urnLead) user.lead = urnLead;

  const evento: Record<string, any> = {
    conversion: regra,
    conversionHappenedAt: params.agoraMs ?? Date.now(),
    user,
    eventId: idEventoLinkedIn(lead?.id, etapa)
  };

  const valor = params.valor;
  if (typeof valor === "number" && Number.isFinite(valor) && valor > 0) {
    evento.conversionValue = { currencyCode: params.moeda || "BRL", amount: valor.toFixed(2) };
  }
  return evento;
}

// Campanha de lead gen otimizada por lead qualificado: lance automático
// (costType sempre CPM, sem unitCost — o doc diz que no automático o unitCost
// assume 0) com optimizationTargetType MAX_QUALIFIED_LEAD. Só vale pro
// objetivo LEAD_GENERATION; pra qualquer outro devolve o payload igual.
// Nunca altera o objeto recebido.
export function aplicarOtimizacaoLeadQualificado<T extends Record<string, any>>(payload: T): T {
  if (payload?.objectiveType !== "LEAD_GENERATION") return { ...payload };
  const { unitCost: _lanceManual, ...resto } = payload;
  return { ...resto, costType: "CPM", optimizationTargetType: OTIMIZACAO_LEAD_QUALIFICADO } as unknown as T;
}

export function campanhaOtimizadaPorLeadQualificado(payload: any): boolean {
  return payload?.optimizationTargetType === OTIMIZACAO_LEAD_QUALIFICADO;
}
