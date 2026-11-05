/**
 * Criação de campanhas TikTok pelas APIs "Upgraded Smart+".
 *
 * A partir de 01/01/2027 o TikTok deixa de aceitar /campaign/create/,
 * /adgroup/create/ e /ad/create/ para campanhas Lead Generation fora de
 * Pesquisa (banner da doc oficial, conferido em 2026-11-04). Este módulo
 * concentra os payloads do fluxo novo, conferidos contra:
 *  - /smart_plus/campaign/create/  (request_id obrigatório, objective_type)
 *  - /smart_plus/adgroup/create/   (targeting_spec, budget no grupo com CBO off)
 *  - /smart_plus/ad/create/        (creative_list, ad_text_list, page_list,
 *                                   ad_configuration.call_to_action_id)
 *  - guias "Lead Generation with Location as Instant Form" e
 *    "... optimization location as instant messaging apps" (WhatsApp).
 *
 * O que NÃO tem equivalente direto no Smart+ (por isso cai no fluxo legado
 * enquanto ele existir e é bloqueado com mensagem clara depois do corte):
 *  - destino "site": Smart+ exige Pixel + evento de otimização; a plataforma
 *    publica site otimizando por clique, sem Pixel;
 *  - formato "imagem única": Smart+ só tem vídeo, post do TikTok e carrossel
 *    (carrossel exige música, e a recomendação de música pede 2+ imagens);
 *  - identidade personalizada (CUSTOMIZED_USER) ou AUTH_CODE: anúncio não-Spark
 *    no posicionamento TikTok não é mais aceito, e AUTH_CODE só permite usar
 *    post já publicado (tiktok_item_id), não vídeo enviado pela plataforma.
 *
 * Nada aqui foi testado contra uma conta real (ver nota da migração).
 */

import { inicioAgendaTikTok, interpretarDataHoraBrasil } from "./tiktok-utils";

export type DestinoTikTokSmartPlus = "lead_ads" | "site" | "whatsapp";
export type FormatoCriativoTikTok = "video" | "imagem";
export type FluxoCriacaoTikTok = "smart_plus" | "legado";

export type ResultadoTikTokApi = { ok: boolean; data: any; error: string | null };
export type ChamadaTikTok = (
  endpoint: string,
  opts?: { method?: string; body?: any }
) => Promise<ResultadoTikTokApi>;

// Corte anunciado pelo TikTok. Antes dele, o que o Smart+ não cobre continua
// no fluxo legado (comportamento atual); depois, é bloqueado com explicação.
export const CORTE_FLUXO_LEGADO_TIKTOK_MS = Date.UTC(2027, 0, 1);

// Identidades que permitem "Spark Ads Push" (vídeo enviado pela plataforma
// publicado como anúncio da conta TikTok).
export const IDENTIDADES_SMART_PLUS_TIKTOK = ["TT_USER", "BC_AUTH_TT"] as const;

export type DecisaoFluxoTikTok =
  | { ok: true; fluxo: "smart_plus"; avisos: string[] }
  | { ok: true; fluxo: "legado"; motivo: string; avisos: string[] }
  | { ok: false; codigo: string; erro: string };

const texto = (valor: unknown) => (valor === null || valor === undefined ? "" : String(valor).trim());

export function ehFluxoSmartPlusTikTok(configuracoes: any): boolean {
  return texto(configuracoes?.tiktok_fluxo) === "smart_plus";
}

export function decidirFluxoCriacaoTikTok(entrada: {
  destino: DestinoTikTokSmartPlus;
  formato: FormatoCriativoTikTok;
  identityType: string;
  agora?: Date;
}): DecisaoFluxoTikTok {
  const agoraMs = (entrada.agora ?? new Date()).getTime();
  const legadoDisponivel = agoraMs < CORTE_FLUXO_LEGADO_TIKTOK_MS;
  const identidade = texto(entrada.identityType).toUpperCase();

  let motivo = "";
  let codigo = "";
  if (entrada.destino === "site") {
    codigo = "TIKTOK_SMART_PLUS_SITE_REQUIRES_PIXEL";
    motivo = "No formato Smart+ do TikTok, campanhas de leads para site exigem um Pixel TikTok instalado no site com evento de formulário, o que a plataforma ainda não configura.";
  } else if (entrada.formato === "imagem") {
    codigo = "TIKTOK_SMART_PLUS_IMAGE_UNSUPPORTED";
    motivo = "O formato Smart+ do TikTok não aceita anúncio de imagem única; use um vídeo.";
  } else if (!(IDENTIDADES_SMART_PLUS_TIKTOK as readonly string[]).includes(identidade)) {
    codigo = "TIKTOK_SMART_PLUS_IDENTITY_UNSUPPORTED";
    motivo = "O formato Smart+ do TikTok só publica vídeos enviados pela plataforma com uma conta TikTok vinculada (TikTok User ou conta do Business Center). Escolha uma dessas identidades.";
  }

  if (!motivo) {
    return {
      ok: true,
      fluxo: "smart_plus",
      avisos: [
        "Publicação no formato Smart+ do TikTok: o texto do botão é escolhido automaticamente pelo TikTok (CTA dinâmico) e o vídeo é publicado como anúncio Spark da conta escolhida, visível só em anúncios."
      ]
    };
  }
  if (legadoDisponivel) {
    return {
      ok: true,
      fluxo: "legado",
      motivo,
      avisos: [`${motivo} Esta publicação usa o fluxo antigo, que o TikTok aceita só até 31/12/2026.`]
    };
  }
  return {
    ok: false,
    codigo,
    erro: `${motivo} Desde 01/01/2027 o TikTok não cria mais campanhas de leads no fluxo antigo.`
  };
}

// request_id do Smart+: "string representation of a 64-bit integer". Usa 18
// dígitos (sempre < 2^63) para dar idempotência por chamada.
export function gerarRequestIdTikTok(aleatorio: () => number = Math.random): string {
  const prefixo = String(Date.now()).slice(-13).padStart(13, "1");
  let sufixo = "";
  for (let i = 0; i < 5; i++) sufixo += String(Math.floor(aleatorio() * 10) % 10);
  const id = `${prefixo}${sufixo}`.replace(/^0+/, "");
  return id || "1";
}

// Nomes de campanha/grupo/anúncio no Smart+: até 512 caracteres, sem emoji.
export function limparNomeTikTok(valor: unknown, padrao: string): string {
  const limpo = texto(valor)
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512)
    .trim();
  return limpo || padrao;
}

export function formatarDataHoraUtcTikTok(data: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${data.getUTCFullYear()}-${pad(data.getUTCMonth() + 1)}-${pad(data.getUTCDate())} ${pad(data.getUTCHours())}:${pad(data.getUTCMinutes())}:${pad(data.getUTCSeconds())}`;
}

// Campanha: sem CBO e sem limite no nível da campanha, para o orçamento
// diário continuar no grupo de anúncios (mesma divisão do fluxo legado, e a
// edição de orçamento continua sendo no grupo).
export function montarPayloadCampanhaSmartPlus(entrada: {
  advertiserId: string;
  nome: unknown;
  requestId: string;
}) {
  return {
    advertiser_id: String(entrada.advertiserId),
    request_id: entrada.requestId,
    objective_type: "LEAD_GENERATION",
    campaign_name: limparNomeTikTok(entrada.nome, "Campanha Leads Plataforma"),
    budget_optimize_on: false,
    budget_mode: "BUDGET_MODE_INFINITE",
    operation_status: "ENABLE"
  };
}

export type TargetingTikTok = {
  location_ids?: string[];
  age_groups?: string[];
  gender?: string;
  interest_category_ids?: string[];
};

export function montarTargetingSpecSmartPlus(targeting: TargetingTikTok) {
  const spec: Record<string, unknown> = {
    location_ids: (targeting.location_ids || []).map(String).filter(Boolean)
  };
  if (targeting.age_groups?.length) spec.age_groups = targeting.age_groups.map(String);
  if (targeting.gender) spec.gender = targeting.gender;
  if (targeting.interest_category_ids?.length) {
    spec.interest_category_ids = targeting.interest_category_ids.map(String);
  }
  return spec;
}

// O calendário do front manda horário de Brasília sem fuso; o TikTok espera
// UTC+0 (mesmos helpers do fluxo legado, em tiktok-utils.ts).
export function montarAgendaSmartPlus(entrada: { inicio?: unknown; fim?: unknown; agora?: Date }) {
  const agora = (entrada.agora ?? new Date()).getTime();
  const agenda: Record<string, string> = {
    schedule_start_time: formatarDataHoraUtcTikTok(inicioAgendaTikTok(entrada.inicio, agora))
  };
  const fimData = interpretarDataHoraBrasil(entrada.fim);
  if (fimData) {
    agenda.schedule_type = "SCHEDULE_START_END";
    agenda.schedule_end_time = formatarDataHoraUtcTikTok(fimData);
  } else {
    agenda.schedule_type = "SCHEDULE_FROM_NOW";
  }
  return agenda;
}

// Grupo de anúncios Smart+:
// - Instant Form: promotion_type LEAD_GENERATION + INSTANT_PAGE, objetivo
//   LEAD_GENERATION, cobrança OCPM;
// - WhatsApp: LEAD_GEN_CLICK_TO_SOCIAL_MEDIA_APP_MESSAGE + WHATSAPP com
//   phone_info, objetivo CLICK, cobrança CPC (não exige conjunto de eventos).
// Segmentação MANUAL para respeitar idade/gênero/interesses escolhidos; sem
// placement_type = posicionamento automático (igual ao fluxo legado).
export function montarPayloadAdgroupSmartPlus(entrada: {
  advertiserId: string;
  campaignId: string;
  requestId: string;
  destino: DestinoTikTokSmartPlus;
  targeting: TargetingTikTok;
  orcamentoDiario: number;
  inicio?: unknown;
  fim?: unknown;
  numeroWhatsapp?: string;
  nome?: string;
  agora?: Date;
}) {
  if (entrada.destino === "site") {
    throw new Error("Destino site não é publicado pelo fluxo Smart+");
  }
  const whatsapp = entrada.destino === "whatsapp";
  if (whatsapp && !texto(entrada.numeroWhatsapp)) {
    throw new Error("Número do WhatsApp obrigatório para o grupo Smart+");
  }
  return {
    advertiser_id: String(entrada.advertiserId),
    campaign_id: String(entrada.campaignId),
    request_id: entrada.requestId,
    adgroup_name: limparNomeTikTok(entrada.nome, `AdGroup Leads ${Date.now()}`),
    ...(whatsapp
      ? {
          promotion_type: "LEAD_GEN_CLICK_TO_SOCIAL_MEDIA_APP_MESSAGE",
          messaging_app_type: "WHATSAPP",
          phone_info: {
            phone_region_code: "BR",
            phone_region_calling_code: "+55",
            phone_number: texto(entrada.numeroWhatsapp)
          },
          optimization_goal: "CLICK",
          billing_event: "CPC"
        }
      : {
          promotion_type: "LEAD_GENERATION",
          promotion_target_type: "INSTANT_PAGE",
          optimization_goal: "LEAD_GENERATION",
          billing_event: "OCPM"
        }),
    bid_type: "BID_TYPE_NO_BID",
    budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET",
    budget: entrada.orcamentoDiario,
    ...montarAgendaSmartPlus({ inicio: entrada.inicio, fim: entrada.fim, agora: entrada.agora }),
    targeting_optimization_mode: "MANUAL",
    targeting_spec: montarTargetingSpecSmartPlus(entrada.targeting),
    operation_status: "ENABLE"
  };
}

export type IdentidadeSmartPlus = {
  identity_id: string;
  identity_type: string;
  identity_authorized_bc_id?: string | null;
};

// null quando a identidade pode publicar vídeo enviado pela plataforma no
// Smart+; senão, o motivo.
export function erroIdentidadeSmartPlus(identidade: IdentidadeSmartPlus): string | null {
  const tipo = texto(identidade.identity_type).toUpperCase();
  if (!texto(identidade.identity_id)) return "Identidade não informada";
  if (!(IDENTIDADES_SMART_PLUS_TIKTOK as readonly string[]).includes(tipo)) {
    return "Identidade não suportada no Smart+";
  }
  if (tipo === "BC_AUTH_TT" && !texto(identidade.identity_authorized_bc_id)) {
    return "identity_authorized_bc_id obrigatório para BC_AUTH_TT";
  }
  return null;
}

// creative_info de um vídeo enviado pela plataforma ("Spark Ads Push"): vídeo,
// capa (image_info.web_uri = image ID) e identidade dentro do criativo.
export function montarCriativoVideoSmartPlus(entrada: {
  videoId: string;
  capaImageId: string;
  identidade: IdentidadeSmartPlus;
}) {
  const tipo = texto(entrada.identidade.identity_type).toUpperCase();
  const bcId = texto(entrada.identidade.identity_authorized_bc_id);
  const erroIdentidade = erroIdentidadeSmartPlus(entrada.identidade);
  if (erroIdentidade) throw new Error(erroIdentidade);
  if (!texto(entrada.videoId) || !texto(entrada.capaImageId)) {
    throw new Error("Vídeo e capa obrigatórios para o criativo Smart+");
  }
  return {
    creative_info: {
      ad_format: "SINGLE_VIDEO",
      video_info: { video_id: texto(entrada.videoId) },
      image_info: [{ web_uri: texto(entrada.capaImageId) }],
      identity_type: tipo,
      identity_id: texto(entrada.identidade.identity_id),
      ...(tipo === "BC_AUTH_TT" ? { identity_authorized_bc_id: bcId } : {})
    }
  };
}

export function montarPayloadAnuncioSmartPlus(entrada: {
  advertiserId: string;
  adgroupId: string;
  destino: DestinoTikTokSmartPlus;
  formId?: string | null;
  identidade: IdentidadeSmartPlus;
  videoId: string;
  capaImageId: string;
  texto: unknown;
  ctaPortfolioId: string;
  nome?: string;
}) {
  if (entrada.destino === "site") {
    throw new Error("Destino site não é publicado pelo fluxo Smart+");
  }
  if (entrada.destino === "lead_ads" && !texto(entrada.formId)) {
    throw new Error("Formulário instantâneo obrigatório");
  }
  if (!texto(entrada.ctaPortfolioId)) {
    throw new Error("Portfólio de CTA obrigatório");
  }
  return {
    advertiser_id: String(entrada.advertiserId),
    adgroup_id: String(entrada.adgroupId),
    ad_name: limparNomeTikTok(entrada.nome, `Anuncio Leads ${Date.now()}`),
    creative_list: [
      montarCriativoVideoSmartPlus({
        videoId: entrada.videoId,
        capaImageId: entrada.capaImageId,
        identidade: entrada.identidade
      })
    ],
    ad_text_list: [{ ad_text: texto(entrada.texto) || "Quer mais clientes? 🚀" }],
    // Instant Form vai em page_list; no WhatsApp o TikTok preenche o destino
    // a partir do grupo (landing_page_url_list e page_list ficam vazios).
    ...(entrada.destino === "lead_ads" ? { page_list: [{ page_id: texto(entrada.formId) }] } : {}),
    ad_configuration: { call_to_action_id: texto(entrada.ctaPortfolioId) },
    operation_status: "ENABLE"
  };
}

// /smart_plus/ad/update/ é incremental; creative_list, se enviado, substitui a
// lista inteira — por isso só vai quando a mídia ou a identidade mudou.
export function montarPayloadEdicaoAnuncioSmartPlus(entrada: {
  advertiserId: string;
  smartPlusAdId: string;
  destino: DestinoTikTokSmartPlus;
  texto: string;
  formId?: string | null;
  criativo?: ReturnType<typeof montarCriativoVideoSmartPlus> | null;
}) {
  return {
    advertiser_id: String(entrada.advertiserId),
    smart_plus_ad_id: String(entrada.smartPlusAdId),
    ad_text_list: [{ ad_text: entrada.texto }],
    ...(entrada.destino === "lead_ads" && texto(entrada.formId)
      ? { page_list: [{ page_id: texto(entrada.formId) }] }
      : {}),
    ...(entrada.criativo ? { creative_list: [entrada.criativo] } : {})
  };
}

export function endpointsStatusTikTok(smartPlus: boolean) {
  return smartPlus
    ? {
        campanha: "/smart_plus/campaign/status/update/",
        adgroup: "/smart_plus/adgroup/status/update/",
        anuncio: "/smart_plus/ad/status/update/",
        chaveAnuncios: "smart_plus_ad_ids"
      }
    : {
        campanha: "/campaign/status/update/",
        adgroup: "/adgroup/status/update/",
        anuncio: "/ad/status/update/",
        chaveAnuncios: "ad_ids"
      };
}

// Converte o grupo Smart+ (targeting dentro de targeting_spec) no mesmo
// formato do grupo legado, para a tela de edição não precisar de outro ramo.
export function normalizarAdgroupSmartPlus(item: any) {
  if (!item) return null;
  const spec = item.targeting_spec || {};
  return {
    adgroup_id: texto(item.adgroup_id) || null,
    campaign_id: texto(item.campaign_id) || null,
    adgroup_name: item.adgroup_name ?? null,
    budget: item.budget ?? null,
    schedule_type: item.schedule_type ?? null,
    schedule_start_time: item.schedule_start_time ?? null,
    schedule_end_time: item.schedule_end_time ?? null,
    location_ids: Array.isArray(spec.location_ids) ? spec.location_ids.map(String) : [],
    age_groups: Array.isArray(spec.age_groups) ? spec.age_groups.map(String) : [],
    gender: spec.gender ?? null,
    interest_category_ids: Array.isArray(spec.interest_category_ids)
      ? spec.interest_category_ids.map(String)
      : [],
    promotion_type: item.promotion_type ?? null,
    optimization_goal: item.optimization_goal ?? null,
    billing_event: item.billing_event ?? null,
    targeting_optimization_mode: item.targeting_optimization_mode ?? null
  };
}

export function normalizarAnuncioSmartPlus(item: any) {
  if (!item) return null;
  const criativos = Array.isArray(item.creative_list) ? item.creative_list : [];
  const ativo = criativos.find((c: any) => c?.material_operation_status !== "DISABLE") || criativos[0] || null;
  const info = ativo?.creative_info || {};
  const config = item.ad_configuration || {};
  const videoId = texto(info.video_info?.video_id);
  const imagens = Array.isArray(info.image_info)
    ? info.image_info.map((img: any) => texto(img?.web_uri)).filter(Boolean)
    : [];
  return {
    ad_id: texto(item.smart_plus_ad_id) || null,
    adgroup_id: texto(item.adgroup_id) || null,
    ad_name: item.ad_name ?? null,
    ad_text: texto(item.ad_text_list?.[0]?.ad_text) || null,
    call_to_action: texto(item.call_to_action_list?.[0]?.call_to_action) || null,
    call_to_action_id: texto(config.call_to_action_id) || null,
    page_id: texto(item.page_list?.[0]?.page_id) || null,
    landing_page_url: texto(item.landing_page_url_list?.[0]?.landing_page_url) || null,
    identity_id: texto(info.identity_id || config.identity_id) || null,
    identity_type: texto(info.identity_type || config.identity_type) || null,
    identity_authorized_bc_id: texto(info.identity_authorized_bc_id || config.identity_authorized_bc_id) || null,
    video_id: videoId || null,
    // No vídeo, image_info é a capa — não pode virar "imagens do anúncio".
    image_ids: videoId ? [] : imagens,
    capa_image_id: videoId ? imagens[0] || null : null,
    operation_status: item.operation_status ?? null
  };
}

const esperar = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Capa do vídeo (obrigatória no Smart+): /file/video/suggestcover/ devolve
// candidatos cujo "id" é o image ID aceito em image_info.web_uri. Logo após
// o upload o vídeo pode ainda estar processando, por isso há novas tentativas.
export async function obterCapaVideoTikTok(
  chamar: ChamadaTikTok,
  advertiserId: string,
  videoId: string,
  opcoes: { tentativas?: number; intervaloMs?: number } = {}
): Promise<{ ok: true; imageId: string } | { ok: false; erro: string }> {
  const tentativas = Math.max(1, opcoes.tentativas ?? 4);
  const intervalo = opcoes.intervaloMs ?? 2000;
  let ultimoErro = "";
  for (let i = 0; i < tentativas; i++) {
    const params = new URLSearchParams({
      advertiser_id: String(advertiserId),
      video_id: String(videoId),
      poster_number: "1"
    });
    const resposta = await chamar(`/file/video/suggestcover/?${params}`);
    const lista = Array.isArray(resposta.data?.data?.list) ? resposta.data.data.list : [];
    const imageId = texto(lista[0]?.id);
    if (resposta.ok && imageId) return { ok: true, imageId };
    ultimoErro = resposta.error || "O TikTok não gerou a capa do vídeo";
    if (i < tentativas - 1) await esperar(intervalo);
  }
  return { ok: false, erro: ultimoErro };
}

// Teste na conta real (2026-11-05): /creative/cta/recommend/ devolve ~24
// botões genéricos para LEAD_GENERATION, inclusive "Jogar", "Instalar agora" e
// "Obter ingressos agora". O portfólio fica só com os que fazem sentido para
// captar lead (textos em pt, ou em inglês quando o pt não vem).
export const CTAS_LEADS_TIKTOK = new Set([
  "tenho interesse", "cadastre-se", "inscrever-se agora", "saber mais",
  "fale conosco", "obter cotação", "ler mais", "enviar mensagem",
  "interested", "sign up", "apply now", "learn more",
  "contact us", "get quote", "read more", "send message"
]);

export function montarConteudoPortfolioCta(recomendados: any[]) {
  const todos = (Array.isArray(recomendados) ? recomendados : [])
    .map(item => ({
      asset_content: texto(item?.asset_content),
      asset_ids: Array.isArray(item?.asset_ids) ? item.asset_ids.map(String).filter(Boolean) : []
    }))
    .filter(item => item.asset_content && item.asset_ids.length);
  const deLead = todos.filter(item => CTAS_LEADS_TIKTOK.has(item.asset_content.toLowerCase()));
  // Se o TikTok mudar os textos e nenhum casar, usa a recomendação inteira.
  return deLead.length ? deLead : todos;
}

// Mensagens do TikTok que o usuário só resolve fora da plataforma.
export function traduzirErroPublicacaoTikTok(mensagem: unknown): string | null {
  const msg = texto(mensagem);
  if (/outstanding payment|no valid payment method|billing/i.test(msg)) {
    return "A conta de anúncios TikTok está sem forma de pagamento válida ou com pagamento pendente. Regularize em Pagamentos no TikTok Ads Manager e publique de novo.";
  }
  return null;
}

// CTA dinâmico exigido pelos guias Smart+ de Lead Generation: recomenda CTAs
// (/creative/cta/recommend/ new_version=true) e cria um portfólio CTA com eles
// (/creative/portfolio/create/). O ID volta em ad_configuration.call_to_action_id.
export async function criarPortfolioCtaDinamicoTikTok(
  chamar: ChamadaTikTok,
  entrada: { advertiserId: string; promotionType: string; optimizationGoal: string; idioma?: string | null }
): Promise<{ ok: true; portfolioId: string; ctas: string[] } | { ok: false; erro: string }> {
  const recomendar = (idioma: string | null) => {
    const params = new URLSearchParams({
      advertiser_id: String(entrada.advertiserId),
      new_version: "true",
      objective_type: "LEAD_GENERATION",
      promotion_type: entrada.promotionType,
      optimization_goal: entrada.optimizationGoal,
      placements: JSON.stringify(["PLACEMENT_TIKTOK"])
    });
    if (idioma) params.set("language", idioma);
    return chamar(`/creative/cta/recommend/?${params}`);
  };

  const idioma = entrada.idioma === undefined ? "pt" : entrada.idioma;
  let recomendacao = await recomendar(idioma);
  let conteudo = montarConteudoPortfolioCta(recomendacao.data?.data?.recommend_assets);
  if ((!recomendacao.ok || !conteudo.length) && idioma) {
    // Idioma não aceito ou sem recomendação nele: tenta o padrão do TikTok.
    recomendacao = await recomendar(null);
    conteudo = montarConteudoPortfolioCta(recomendacao.data?.data?.recommend_assets);
  }
  if (!recomendacao.ok || !conteudo.length) {
    return { ok: false, erro: recomendacao.error || "O TikTok não recomendou botões (CTA) para este anúncio" };
  }

  const portfolio = await chamar("/creative/portfolio/create/", {
    method: "POST",
    body: {
      advertiser_id: String(entrada.advertiserId),
      creative_portfolio_type: "CTA",
      portfolio_content: conteudo
    }
  });
  const portfolioId = texto(portfolio.data?.data?.creative_portfolio_id);
  if (!portfolio.ok || !portfolioId) {
    return { ok: false, erro: portfolio.error || "Não foi possível criar o portfólio de CTA no TikTok" };
  }
  return { ok: true, portfolioId, ctas: conteudo.map(item => item.asset_content) };
}
