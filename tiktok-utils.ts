import { createHash } from "node:crypto";
import { MOEDA_VALOR_NEGOCIO, NOME_CRM_META } from "./eventos-meta";

// Regras do TikTok Ads que não dependem do banco nem da rede. Conferidas na
// documentação oficial em 2026-11-04:
// - Events API 2.0 (/event/track/): campos user.phone / user.email, telefone em
//   E.164 com "+" antes do hash; event_source "crm" usa o ID de um CRM Event
//   Set (/crm/list/, /crm/create/) e lead.lead_id do formulário instantâneo, e
//   aceita só eventos personalizados.
// - schedule_start_time / schedule_end_time do ad group são UTC+0, no formato
//   "YYYY-MM-DD HH:MM:SS".

export const NOME_FONTE_EVENTOS_TIKTOK = NOME_CRM_META;

export type EventoConversaoTikTok = "QualifiedLead" | "ClosedWon";
export type FonteEventoTikTok = "crm" | "web";

function texto(valor: unknown): string {
  return valor === null || valor === undefined ? "" : String(valor).trim();
}

function sha256Normalizado(valor: string): string {
  return createHash("sha256").update(valor.trim().toLowerCase()).digest("hex");
}

// Lead de formulário instantâneo do TikTok: chegou pela sync/webhook com
// plataforma 'tiktok' e o lead_id nativo. Só ele pode ir pelo canal CRM, que
// casa pelo lead_id (sem depender de e-mail ou telefone).
export function fonteEventoTikTok(lead: any): FonteEventoTikTok {
  return texto(lead?.plataforma).toLowerCase() === "tiktok" && texto(lead?.lead_id) ? "crm" : "web";
}

export function leadIdentificavelTikTok(lead: any): boolean {
  return fonteEventoTikTok(lead) === "crm" || Boolean(texto(lead?.email) || texto(lead?.telefone));
}

function atribuicaoDoLead(lead: any): Record<string, any> {
  let atribuicao: any = lead?.atribuicao ?? {};
  if (typeof atribuicao === "string") {
    try { atribuicao = JSON.parse(atribuicao); } catch { atribuicao = {}; }
  }
  return atribuicao && typeof atribuicao === "object" ? atribuicao : {};
}

function urlHttp(valor: unknown): string {
  const url = texto(valor);
  return /^https?:\/\//i.test(url) ? url : "";
}

function contatoComHashTikTok(lead: any, telefoneE164: unknown): Record<string, string> {
  const usuario: Record<string, string> = {};
  const email = texto(lead?.email);
  if (email) usuario.email = sha256Normalizado(email);
  const telefone = texto(telefoneE164);
  if (/^\+\d{8,15}$/.test(telefone)) usuario.phone = sha256Normalizado(telefone);
  return usuario;
}

// Usuário de um evento web (Events API 2.0, event_source "web"): casa por
// ttclid (gravado pelo formulário do site a partir da URL do clique), e-mail
// e telefone com hash. IP e navegador só complementam — sozinhos não
// identificam o lead.
function usuarioEventoWebTikTok(
  lead: any,
  atribuicao: Record<string, any>,
  telefoneE164: unknown
): Record<string, string> | null {
  const ttclid = texto(atribuicao.ttclid);
  const usuario: Record<string, string> = {
    ...(ttclid ? { ttclid } : {}),
    ...contatoComHashTikTok(lead, telefoneE164),
  };
  if (!Object.keys(usuario).length) return null;
  const ip = texto(atribuicao.ip);
  if (ip) usuario.ip = ip;
  const navegador = texto(atribuicao.user_agent);
  if (navegador) usuario.user_agent = navegador;
  return usuario;
}

// page de um evento web: a Events API 2.0 exige page.url (conferido na
// documentação em 2026-11-05). Vale a página do site onde o lead se cadastrou;
// sem ela (ex.: lead de WhatsApp), a página informada por quem chama.
function paginaEventoWebTikTok(
  atribuicao: Record<string, any>,
  paginaPadrao?: string | null
): { url: string; referrer?: string } | null {
  const url = urlHttp(atribuicao.pagina) || urlHttp(paginaPadrao);
  if (!url) return null;
  const referrer = urlHttp(atribuicao.referrer);
  return { url, ...(referrer ? { referrer } : {}) };
}

export function montarEventoTikTok(params: {
  lead: any;
  evento: EventoConversaoTikTok;
  fonte: FonteEventoTikTok;
  // Telefone já em E.164 com "+" (mesma normalização do Google, ver
  // normalizarTelefoneE164Google no index.ts).
  telefoneE164?: string | null;
  valorVenda?: number | null;
  // page.url do evento web quando o lead não tem a página do site (ex.: lead
  // de WhatsApp). Sem nenhuma das duas o evento web não é montado.
  paginaPadrao?: string | null;
  agoraSegundos?: number;
}): Record<string, any> | null {
  const { lead, evento, fonte } = params;
  const leadId = texto(lead?.lead_id);
  let usuario: Record<string, string> | null;
  let pagina: { url: string; referrer?: string } | null = null;

  if (fonte === "crm") {
    if (!leadId) return null;
    usuario = contatoComHashTikTok(lead, params.telefoneE164);
  } else {
    const atribuicao = atribuicaoDoLead(lead);
    usuario = usuarioEventoWebTikTok(lead, atribuicao, params.telefoneE164);
    pagina = paginaEventoWebTikTok(atribuicao, params.paginaPadrao);
    if (!usuario || !pagina) return null;
  }

  const item: Record<string, any> = {
    event: evento,
    event_time: params.agoraSegundos ?? Math.floor(Date.now() / 1000),
    // Repetir o envio (ex.: falha de rede depois do TikTok aceitar) não conta
    // a mesma etapa duas vezes.
    ...(texto(lead?.id) ? { event_id: `${texto(lead.id)}-${evento}` } : {}),
  };
  if (Object.keys(usuario).length) item.user = usuario;
  if (pagina) item.page = pagina;
  if (fonte === "crm") {
    item.lead = { lead_id: leadId, lead_event_source: NOME_FONTE_EVENTOS_TIKTOK };
  }
  if (params.valorVenda !== null && params.valorVenda !== undefined) {
    item.properties = { value: params.valorVenda, currency: MOEDA_VALOR_NEGOCIO };
  }
  return item;
}

// Evento padrão "Lead" (optimization_event FORM) quando chega lead pelo
// formulário do site vindo de anúncio do TikTok — é com ele que a campanha
// Smart+ de site aprende. Só sai com a página do site (sem página padrão).
export function montarEventoLeadSiteTikTok(params: {
  lead: any;
  telefoneE164?: string | null;
  agoraSegundos?: number;
}): Record<string, any> | null {
  const { lead } = params;
  const atribuicao = atribuicaoDoLead(lead);
  const pagina = paginaEventoWebTikTok(atribuicao);
  const usuario = usuarioEventoWebTikTok(lead, atribuicao, params.telefoneE164);
  if (!pagina || !usuario) return null;
  return {
    event: "Lead",
    event_time: params.agoraSegundos ?? Math.floor(Date.now() / 1000),
    ...(texto(lead?.id) ? { event_id: `${texto(lead.id)}-Lead` } : {}),
    user: usuario,
    page: pagina
  };
}

// Lê o ID da fonte de eventos com o nome da plataforma numa resposta de
// /pixel/list/ (busca por nome é aproximada) ou /crm/list/.
export function idFonteEventosTikTokNaLista(
  payload: any,
  tipo: "pixel" | "crm",
  nome = NOME_FONTE_EVENTOS_TIKTOK
): string | null {
  const dados = payload?.data ?? {};
  const lista = tipo === "crm" ? dados.crm_event_sets : dados.pixels;
  if (!Array.isArray(lista)) return null;
  const alvo = nome.trim().toLowerCase();
  const item = lista.find((x: any) =>
    texto(tipo === "crm" ? x?.name : x?.pixel_name).toLowerCase() === alvo
  );
  const id = texto(tipo === "crm" ? item?.event_set_id : item?.pixel_code);
  return id || null;
}

// Ao reconectar, o OAuth devolve só advertiser_ids. Se a conta escolhida
// continua autorizada, mantém a escolha (conta, identidade e fontes de
// eventos); senão começa do zero para o corretor escolher de novo.
const CHAVES_MANTIDAS_RECONEXAO = [
  "advertiser_id",
  "identity_id",
  "identity_type",
  "pixel_code",
  "pixel_advertiser_id",
  "crm_event_set_id",
  "crm_advertiser_id",
];

export function dadosContaTikTokAposReconexao(anterior: any, advertiserIds: unknown): Record<string, any> {
  const ids = Array.isArray(advertiserIds) ? advertiserIds.map(texto).filter(Boolean) : [];
  const novo: Record<string, any> = { advertiser_ids: ids };
  const contaAnterior = texto(anterior?.advertiser_id);
  if (!contaAnterior || !ids.includes(contaAnterior)) return novo;
  for (const chave of CHAVES_MANTIDAS_RECONEXAO) {
    if (anterior?.[chave] !== undefined && anterior?.[chave] !== null) novo[chave] = anterior[chave];
  }
  return novo;
}

// ---------- Datas da agenda do ad group ----------

// O calendário do front manda "YYYY-MM-DDTHH:MM" em horário de Brasília, sem
// fuso (mesma regra de dataHoraBrasilParaIsoMeta no index.ts).
export function interpretarDataHoraBrasil(valor: unknown): Date | null {
  const bruto = texto(valor);
  if (!bruto) return null;
  const temFuso = /(?:Z|[+-]\d{2}:\d{2})$/i.test(bruto);
  const candidato = !temFuso && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(bruto)
    ? `${bruto}-03:00`
    : bruto;
  const data = new Date(candidato);
  return Number.isFinite(data.getTime()) ? data : null;
}

// Início da veiculação: o horário escolhido, ou daqui a 1 minuto quando não há
// data ou ela já passou (rascunho publicado depois da data marcada).
export function inicioAgendaTikTok(valor: unknown, agora = Date.now()): Date {
  const data = interpretarDataHoraBrasil(valor);
  const minimo = agora + 60_000;
  return data && data.getTime() > minimo ? data : new Date(minimo);
}

// "YYYY-MM-DD HH:MM:SS" (UTC) do TikTok -> "YYYY-MM-DDTHH:MM" em Brasília,
// para preencher o calendário da edição.
export function dataTikTokParaBrasil(valor: unknown): string {
  const bruto = texto(valor);
  const m = bruto.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (!m) return bruto;
  const utc = new Date(`${m[1]}T${m[2]}:${m[3] || "00"}Z`);
  if (!Number.isFinite(utc.getTime())) return bruto;
  return new Date(utc.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

// ---------- Linha do CSV de leads (/page/lead/task/download/) ----------

function normalizarChaveCsv(chave: string): string {
  return chave.trim().toLowerCase().replace(/[\s_]+/g, "_");
}

// A TikTok não documenta os nomes exatos das colunas do export: compara sem
// espaço/underscore/maiúsculas.
export function valorCsvPorChavesPossiveis(linha: Record<string, string>, chaves: string[]): string {
  const normalizadas: Record<string, string> = {};
  for (const chaveOriginal of Object.keys(linha)) {
    const normalizada = normalizarChaveCsv(chaveOriginal);
    if (!(normalizada in normalizadas)) normalizadas[normalizada] = linha[chaveOriginal];
  }
  for (const chave of chaves) {
    const valor = normalizadas[chave];
    if (valor) return valor;
  }
  return "";
}

const CHAVES_DATA_LEAD = ["create_time", "created_time", "submit_time"];
const CAMPOS_CONHECIDOS_LEAD = new Set([
  "lead_id", "campaign_id", "campaign_name", "full_name", "name", "first_name",
  "last_name", "email", "phone_number", "phone", ...CHAVES_DATA_LEAD,
  "page_id", "adgroup_id", "adgroup_name", "ad_id", "ad_name",
]);

export function extrairLeadCsvTikTok(linha: Record<string, string>) {
  const criadoEmTexto = valorCsvPorChavesPossiveis(linha, CHAVES_DATA_LEAD);
  const criadoEmData = criadoEmTexto ? new Date(criadoEmTexto) : null;
  return {
    leadId: valorCsvPorChavesPossiveis(linha, ["lead_id"]),
    campaignId: valorCsvPorChavesPossiveis(linha, ["campaign_id"]),
    campaignName: valorCsvPorChavesPossiveis(linha, ["campaign_name"]),
    nome: valorCsvPorChavesPossiveis(linha, ["full_name", "name", "first_name"]) || "Lead TikTok",
    email: valorCsvPorChavesPossiveis(linha, ["email"]),
    telefone: valorCsvPorChavesPossiveis(linha, ["phone_number", "phone"]),
    respostas: Object.keys(linha)
      .filter(chave => !CAMPOS_CONHECIDOS_LEAD.has(normalizarChaveCsv(chave)))
      .map(chave => ({ pergunta: chave, resposta: linha[chave] })),
    // Data ilegível não pode derrubar a sincronização: o lead entra com NOW().
    criadoEm: criadoEmData && Number.isFinite(criadoEmData.getTime()) ? criadoEmData.toISOString() : null,
  };
}
