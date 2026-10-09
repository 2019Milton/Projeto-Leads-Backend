/**
 * Conjuntos de anúncios Meta associados a uma campanha.
 * Consulta de leitura e criação explicitamente pausada, sem alterar campanha original.
 */
import { verificarAnuncioOriginalWhatsapp, criarAnuncioPausadoMeta } from "./meta-duplicacao-anuncio";
type Req = (url: string, init?: RequestInit) => Promise<Response>;
type Dict = Record<string, any>;
const BASE = "https://graph.facebook.com/v25.0/";
const objeto = (v: unknown): Dict => v && typeof v === "object" && !Array.isArray(v) ? v as Dict : {};
const texto = (v: unknown): string => typeof v === "string" ? v.trim() : "";
const inteiro = (v: unknown): number => Number.isSafeInteger(Number(v)) ? Number(v) : 0;
const dinheiro = (v: unknown): number => Math.round((Number(v) || 0) * 100) / 100;
const idValido = (v: unknown) => /^\d+$/.test(String(v || ""));

async function consultar(url: string, token: string, req: Req): Promise<Dict> {
  const uri = new URL(url);
  if (uri.protocol !== "https:" || uri.hostname !== "graph.facebook.com") {
    throw new Error("Endereço de paginação não permitido");
  }
  const resposta = await req(url, { headers: { Authorization: "Bearer " + token } });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok || dados.error) {
    const codigo = inteiro(dados?.error?.code) || resposta.status;
    throw new Error("Meta recusou a consulta (código " + codigo + ")");
  }
  return objeto(dados);
}

async function listar(path: string, fields: string, token: string, req: Req): Promise<Dict[]> {
  const itens: Dict[] = [];
  let url: string | null = BASE + path + "?fields=" + encodeURIComponent(fields) + "&limit=100";
  const vistos = new Set<string>();
  while (url && vistos.size < 3 && itens.length < 300) {
    if (vistos.has(url)) break;
    vistos.add(url);
    const pagina = await consultar(url, token, req);
    if (!Array.isArray(pagina.data)) throw new Error("Resposta inesperada da Meta");
    itens.push(...pagina.data);
    url = typeof pagina.paging?.next === "string" ? pagina.paging.next : null;
  }
  return itens.slice(0, 300);
}

function numCriativo(criativo: Dict): string | null {
  const story = objeto(criativo.object_story_spec);
  for (const conteudo of [story.link_data, story.video_data, story.template_data]) {
    const x = objeto(conteudo);
    const valor = objeto(objeto(x.call_to_action).value);
    const n = texto(valor.whatsapp_number || valor.phone_number);
    if (/^\+?\d[\d\s().+-]{9,18}$/.test(n)) return n.replace(/\D/g, "");
  }
  return null;
}

export async function listarConjuntosCampanhaMeta(
  campanhaId: string, token: string, req: Req = fetch
) {
  if (!idValido(campanhaId)) throw new Error("Campanha inválida");
  const [campanha, conjuntos, anuncios] = await Promise.all([
    consultar(BASE + campanhaId + "?fields=id,name,objective,status,daily_budget,lifetime_budget", token, req),
    listar(campanhaId + "/adsets",
      "id,name,status,effective_status,destination_type,promoted_object,daily_budget,lifetime_budget,optimization_goal",
      token, req),
    listar(campanhaId + "/ads",
      "id,name,adset_id,status,effective_status,creative{id,object_story_spec}", token, req)
  ]);
  let dadosMetricas: Dict[] = [];
  let avisoMetricas: string | null = null;
  try {
    dadosMetricas = await listar(campanhaId + "/insights",
      "adset_id,spend,impressions,clicks,ctr,actions", token,
      (u, init) => req(u.replace("?fields=", "?level=adset&date_preset=last_30d&fields="), init));
  } catch {
    avisoMetricas = "Métricas por conjunto temporariamente indisponíveis na Meta.";
  }
  const porId = new Map(dadosMetricas.map(m => [String(m.adset_id), m]));
  const anunciosPorConjunto = new Map<string, Dict[]>();
  for (const a of anuncios) {
    const key = String(a.adset_id);
    if (!anunciosPorConjunto.has(key)) anunciosPorConjunto.set(key, []);
    anunciosPorConjunto.get(key)!.push(a);
  }
  return {
    campanha: {
      id: String(campanha.id), nome: texto(campanha.name),
      objetivo: texto(campanha.objective), status: texto(campanha.status),
      cbo: inteiro(campanha.daily_budget) > 0 || inteiro(campanha.lifetime_budget) > 0,
      orcamento_diario_centavos: inteiro(campanha.daily_budget),
      orcamento_total_centavos: inteiro(campanha.lifetime_budget)
    },
    periodo_metricas: "Últimos 30 dias",
    aviso_metricas: avisoMetricas,
    conjuntos: conjuntos.map(c => {
      const m = porId.get(String(c.id)) || {};
      const ads = anunciosPorConjunto.get(String(c.id)) || [];
      const meta = texto(objeto(c.promoted_object).whatsapp_phone_number);
      const numeroAnuncio = ads.map(a => numCriativo(objeto(a.creative))).find(Boolean) || null;
      const conversas = Array.isArray(m.actions)
        ? m.actions.filter((x: Dict) => /messaging_conversation_started/i.test(String(x.action_type || "")))
          .reduce((s: number, x: Dict) => s + (Number(x.value) || 0), 0)
        : null;
      return {
        id: String(c.id), nome: texto(c.name),
        status: texto(c.status), status_efetivo: texto(c.effective_status),
        destino: texto(c.destination_type),
        numero_whatsapp: meta || numeroAnuncio || null,
        origem_numero: meta ? "conjunto" : numeroAnuncio ? "criativo" : null,
        orcamento_diario_centavos: inteiro(c.daily_budget),
        orcamento_total_centavos: inteiro(c.lifetime_budget),
        otimizacao: texto(c.optimization_goal),
        metricas: {
          gasto: dinheiro(m.spend), impressoes: inteiro(m.impressions),
          cliques: inteiro(m.clicks), ctr: dinheiro(m.ctr), conversas_meta: conversas
        },
        anuncios: ads.map(a => ({
          id: String(a.id), nome: texto(a.name),
          status: texto(a.status), status_efetivo: texto(a.effective_status)
        }))
      };
    })
  };
}

export function montarConjuntoWhatsappPausado(
  fonte: Dict, campanha: Dict, numeroWhatsapp: string, nome: string,
  orcamentoDiarioCentavos?: number | null
) {
  if (!idValido(fonte.id) || !idValido(campanha.id) ||
      String(fonte.campaign_id) !== String(campanha.id))
    throw new Error("Conjunto de origem não pertence à campanha");
  if (texto(fonte.destination_type) !== "WHATSAPP")
    throw new Error("Selecione um conjunto de origem com destino WhatsApp");
  if (!/^55\d{10,11}$/.test(numeroWhatsapp))
    throw new Error("Número de WhatsApp inválido");
  if (nome.trim().length < 3 || nome.trim().length > 120)
    throw new Error("Nome do conjunto deve ter entre 3 e 120 caracteres");
  const promovido = { ...objeto(fonte.promoted_object), whatsapp_phone_number: numeroWhatsapp };
  if (!promovido.page_id) throw new Error("Conjunto original sem Página vinculada");
  if (!objeto(fonte.targeting).geo_locations)
    throw new Error("Público do conjunto original não está disponível para cópia");
  const cbo = inteiro(campanha.daily_budget) > 0 || inteiro(campanha.lifetime_budget) > 0;
  const payload: Dict = {
    name: nome.trim(),
    campaign_id: String(campanha.id),
    destination_type: "WHATSAPP",
    status: "PAUSED",
    billing_event: texto(fonte.billing_event) || "IMPRESSIONS",
    optimization_goal: texto(fonte.optimization_goal) || "CONVERSATIONS",
    promoted_object: promovido,
    targeting: fonte.targeting
  };
  for (const key of ["attribution_spec", "bid_strategy", "bid_amount"]) {
    if (fonte[key] !== null && fonte[key] !== undefined && fonte[key] !== "") {
      payload[key] = fonte[key];
    }
  }
  if (!cbo) {
    const valor = Number(orcamentoDiarioCentavos);
    if (!Number.isSafeInteger(valor) || valor <= 0)
      throw new Error("Informe orçamento diário do novo conjunto (em centavos)");
    payload.daily_budget = valor;
  }
  return { payload, cbo };
}

export async function criarConjuntoWhatsappPausadoMeta(
  params: {
    campanhaId: string, contaAdsId: string, fonteId: string,
    numeroWhatsapp: string, nome: string, anuncioOrigemId: string,
    orcamentoDiarioCentavos?: number | null, token: string
  },
  req: Req = fetch
) {
  const { campanhaId, contaAdsId, fonteId, anuncioOrigemId, numeroWhatsapp, nome, orcamentoDiarioCentavos, token } = params;
  if (![campanhaId, fonteId, anuncioOrigemId].every(idValido) || !/^act_\d+$/.test(contaAdsId))
    throw new Error("Identificadores da Meta inválidos");
  const [campanha, fonte] = await Promise.all([
    consultar(BASE + campanhaId + "?fields=id,account_id,daily_budget,lifetime_budget", token, req),
    consultar(BASE + fonteId +
      "?fields=id,campaign_id,destination_type,promoted_object,targeting,billing_event,optimization_goal,attribution_spec,bid_strategy,bid_amount",
      token, req)
  ]);
  if (String(campanha.account_id || "").replace(/^act_/i, "") !== contaAdsId.replace(/^act_/i, "")) {
    throw new Error("A campanha remota pertence a outra conta de anúncios");
  }
  const { payload, cbo } = montarConjuntoWhatsappPausado(fonte, campanha, numeroWhatsapp, nome, orcamentoDiarioCentavos);
  // Pré-valida o anúncio de origem e prepara um NOVO criativo com o WhatsApp novo
  // ANTES de qualquer POST para a Meta. Nunca reutiliza um criativo com o número anterior.
  const copia = await verificarAnuncioOriginalWhatsapp({
    campanhaId, contaAdsId, conjuntoOrigemId: fonteId, anuncioOrigemId,
    paginaOrigem: String(objeto(fonte.promoted_object).page_id),
    numeroDestino: numeroWhatsapp, token
  }, req);
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  const resposta = await req(BASE + contaAdsId + "/adsets", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok || dados.error || !idValido(dados.id)) {
    const codigo = inteiro(dados?.error?.code) || resposta.status;
    throw new Error("Meta recusou a criação do conjunto (código " + codigo + "). Verifique permissões, orçamento e público.");
  }
  const conjuntoId = String(dados.id);
  let numeroConfirmado: string | null = null;
  let statusConfirmado: string | null = null;
  let verificacaoConjuntoOk = false;
  try {
    const criado = await consultar(BASE + conjuntoId +
      "?fields=id,status,campaign_id,destination_type,promoted_object", token, req);
    numeroConfirmado = texto(objeto(criado.promoted_object).whatsapp_phone_number) || null;
    statusConfirmado = texto(criado.status);
    verificacaoConjuntoOk =
      String(criado.campaign_id) === campanhaId &&
      statusConfirmado === "PAUSED" &&
      texto(criado.destination_type) === "WHATSAPP" &&
      numeroConfirmado?.replace(/\D/g,"") === numeroWhatsapp;
  } catch {
    // Nenhum anúncio será criado se a Meta não confirmar o status e o WhatsApp.
  }
  const parcial = (aviso: string, anuncioId: string | null = null) => ({
    id: conjuntoId, nome: payload.name,
    status: statusConfirmado || "NAO_VERIFICADO",
    numero_solicitado: numeroWhatsapp, numero_confirmado: numeroConfirmado,
    numero_verificado: numeroConfirmado?.replace(/\D/g,"") === numeroWhatsapp,
    cbo, anuncio_criado: Boolean(anuncioId), anuncio_id: anuncioId,
    parcial: true, aviso
  });
  if (!verificacaoConjuntoOk) {
    return parcial("O conjunto foi criado, mas a Meta não confirmou o destino e o status PAUSADO. Nenhum anúncio foi copiado. Confira o conjunto na Meta antes de qualquer nova tentativa.");
  }
  let anuncioId: string;
  try {
    anuncioId = await criarAnuncioPausadoMeta({
      contaAdsId, conjuntoId,
      nome: copia.nome + " - " + nome,
      criativo: copia.criativo, token
    }, req);
  } catch (e) {
    return parcial("O conjunto foi criado PAUSADO, mas a Meta recusou copiar o anúncio: " +
      (e instanceof Error ? e.message : "erro inesperado") +
      " Não repita a criação; confira o conjunto na Meta.");
  }
  let anuncioPausado = false;
  let destinoCriativoConfirmado = false;
  try {
    const a = await consultar(BASE + anuncioId +
      "?fields=id,status,adset_id,creative{id}", token, req);
    anuncioPausado = String(a.adset_id) === conjuntoId && texto(a.status) === "PAUSED";
    const creativeId = String(objeto(a.creative).id || "");
    if (anuncioPausado && idValido(creativeId)) {
      const criativoCriado = await consultar(BASE + creativeId +
        "?fields=id,object_story_spec",token,req);
      const spec=objeto(criativoCriado.object_story_spec);
      const conteudo=objeto(spec.link_data || spec.video_data);
      const numeroLido=texto(objeto(objeto(conteudo.call_to_action).value).whatsapp_number).replace(/\D/g,"");
      destinoCriativoConfirmado = numeroLido === numeroWhatsapp;
    }
  } catch {
    // Se a Meta não puder confirmar o novo criativo, não sinaliza sucesso completo.
  }
  if (!anuncioPausado || !destinoCriativoConfirmado) {
    return parcial("Conjunto e anúncio foram criados, mas a Meta não confirmou ambos os status e o WhatsApp do novo criativo. Verifique os IDs na Meta antes de ativar.", anuncioId);
  }
  return {
    ...parcial("Conjunto e anúncio PAUSADOS, WhatsApp do conjunto e do criativo confirmados. Faça a última conferência na prévia da Meta.", anuncioId),
    parcial: false,
    status: "PAUSED"
  };
}
