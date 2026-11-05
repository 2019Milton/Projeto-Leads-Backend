import { describe, expect, test } from "bun:test";
import {
  CORTE_FLUXO_LEGADO_TIKTOK_MS,
  criarPortfolioCtaDinamicoTikTok,
  criativoAceitoNoSmartPlus,
  decidirFluxoCriacaoTikTok,
  ehFluxoSmartPlusTikTok,
  endpointsStatusTikTok,
  erroIdentidadeSmartPlus,
  erroPixelTikTok,
  gerarRequestIdTikTok,
  limparNomeTikTok,
  montarAgendaSmartPlus,
  montarConteudoPortfolioCta,
  montarCriativoVideoSmartPlus,
  montarPayloadAdgroupSmartPlus,
  montarPayloadAnuncioSmartPlus,
  montarPayloadCampanhaSmartPlus,
  montarPayloadEdicaoAnuncioSmartPlus,
  montarTargetingSpecSmartPlus,
  normalizarAdgroupSmartPlus,
  normalizarAnuncioSmartPlus,
  obterCapaVideoTikTok,
  pixelDaPlataformaTikTok,
  traduzirErroPublicacaoTikTok,
  type ChamadaTikTok
} from "./tiktok-smart-plus";

const ANTES_DO_CORTE = new Date("2026-11-05T12:00:00Z");
const DEPOIS_DO_CORTE = new Date("2027-01-01T00:00:01Z");
const identidadeBc = { identity_id: "7000", identity_type: "BC_AUTH_TT", identity_authorized_bc_id: "BC1" };

describe("decidirFluxoCriacaoTikTok", () => {
  test("Instant Form e WhatsApp com vídeo e identidade Spark vão para Smart+", () => {
    for (const destino of ["lead_ads", "whatsapp"] as const) {
      for (const identityType of ["TT_USER", "BC_AUTH_TT", "bc_auth_tt"]) {
        const d = decidirFluxoCriacaoTikTok({ destino, formato: "video", identityType, agora: ANTES_DO_CORTE });
        expect(d).toMatchObject({ ok: true, fluxo: "smart_plus" });
        const depois = decidirFluxoCriacaoTikTok({ destino, formato: "video", identityType, agora: DEPOIS_DO_CORTE });
        expect(depois).toMatchObject({ ok: true, fluxo: "smart_plus" });
      }
    }
  });

  test("site, imagem e identidade não-Spark ficam no legado antes do corte", () => {
    const casos = [
      { destino: "site" as const, formato: "video" as const, identityType: "BC_AUTH_TT" },
      { destino: "site" as const, formato: "video" as const, identityType: "TT_USER", site: { eventos: false, pixel: true } },
      { destino: "site" as const, formato: "video" as const, identityType: "TT_USER", site: { eventos: true, pixel: false } },
      { destino: "site" as const, formato: "imagem" as const, identityType: "TT_USER", site: { eventos: true, pixel: true } },
      { destino: "lead_ads" as const, formato: "imagem" as const, identityType: "TT_USER" },
      { destino: "whatsapp" as const, formato: "video" as const, identityType: "CUSTOMIZED_USER" },
      { destino: "lead_ads" as const, formato: "video" as const, identityType: "AUTH_CODE" }
    ];
    for (const caso of casos) {
      const d = decidirFluxoCriacaoTikTok({ ...caso, agora: ANTES_DO_CORTE });
      expect(d).toMatchObject({ ok: true, fluxo: "legado" });
      expect((d as any).avisos[0]).toContain("31/12/2026");
    }
  });

  test("site com código do formulário e Pixel vai para Smart+ otimizando por lead", () => {
    for (const agora of [ANTES_DO_CORTE, DEPOIS_DO_CORTE]) {
      const d: any = decidirFluxoCriacaoTikTok({
        destino: "site", formato: "video", identityType: "BC_AUTH_TT", agora,
        site: { eventos: true, pixel: true }
      });
      expect(d).toMatchObject({ ok: true, fluxo: "smart_plus" });
      expect(d.avisos.join(" ")).toContain("evento Lead");
    }
  });

  test("site: motivo do legado diz o que falta (código, plano ou Pixel)", () => {
    const motivo = (site: any) =>
      (decidirFluxoCriacaoTikTok({ destino: "site", formato: "video", identityType: "TT_USER", agora: ANTES_DO_CORTE, site }) as any).motivo;
    expect(motivo({ eventos: false, pixel: true })).toContain("código do formulário");
    expect(motivo({ eventos: false, semEventosPorPlano: true, pixel: true })).toContain("plano");
    expect(motivo({ eventos: true, pixel: false, erroPixel: "o TikTok não liberou o acesso a Pixels." }))
      .toBe("No formato Smart+ do TikTok, a campanha para site precisa do Pixel da plataforma na conta de anúncios, e o TikTok não liberou o acesso a Pixels.");
    // Sem Pixel pesa mais que sem código.
    expect(motivo({ eventos: false, pixel: false })).toContain("Pixel");
  });

  test("site depois do corte: publica com Pixel mesmo sem código; sem Pixel bloqueia", () => {
    const semCodigo: any = decidirFluxoCriacaoTikTok({
      destino: "site", formato: "video", identityType: "TT_USER", agora: DEPOIS_DO_CORTE,
      site: { eventos: false, pixel: true }
    });
    expect(semCodigo).toMatchObject({ ok: true, fluxo: "smart_plus" });
    expect(semCodigo.avisos[1]).toContain("só aprende");
    for (const site of [undefined, { eventos: true, pixel: false }, { eventos: true, pixel: null }]) {
      expect(decidirFluxoCriacaoTikTok({ destino: "site", formato: "video", identityType: "TT_USER", agora: DEPOIS_DO_CORTE, site }))
        .toMatchObject({ ok: false, codigo: "TIKTOK_SMART_PLUS_SITE_PIXEL_UNAVAILABLE" });
    }
  });

  test("criativoAceitoNoSmartPlus: só vídeo com identidade Spark", () => {
    expect(criativoAceitoNoSmartPlus("video", "bc_auth_tt")).toBe(true);
    expect(criativoAceitoNoSmartPlus("video", "TT_USER")).toBe(true);
    expect(criativoAceitoNoSmartPlus("imagem", "TT_USER")).toBe(false);
    expect(criativoAceitoNoSmartPlus("video", "CUSTOMIZED_USER")).toBe(false);
    expect(criativoAceitoNoSmartPlus("video", null)).toBe(false);
  });

  test("depois de 01/01/2027 o que o Smart+ não cobre é bloqueado com código", () => {
    expect(decidirFluxoCriacaoTikTok({ destino: "site", formato: "imagem", identityType: "TT_USER", agora: DEPOIS_DO_CORTE }))
      .toMatchObject({ ok: false, codigo: "TIKTOK_SMART_PLUS_IMAGE_UNSUPPORTED" });
    expect(decidirFluxoCriacaoTikTok({ destino: "lead_ads", formato: "imagem", identityType: "TT_USER", agora: DEPOIS_DO_CORTE }))
      .toMatchObject({ ok: false, codigo: "TIKTOK_SMART_PLUS_IMAGE_UNSUPPORTED" });
    expect(decidirFluxoCriacaoTikTok({ destino: "lead_ads", formato: "video", identityType: "CUSTOMIZED_USER", agora: DEPOIS_DO_CORTE }))
      .toMatchObject({ ok: false, codigo: "TIKTOK_SMART_PLUS_IDENTITY_UNSUPPORTED" });
  });

  test("o corte é 2027-01-01 00:00 UTC", () => {
    expect(CORTE_FLUXO_LEGADO_TIKTOK_MS).toBe(Date.parse("2027-01-01T00:00:00Z"));
    const noLimite = decidirFluxoCriacaoTikTok({
      destino: "site", formato: "video", identityType: "TT_USER", agora: new Date(CORTE_FLUXO_LEGADO_TIKTOK_MS)
    });
    expect(noLimite.ok).toBe(false);
  });
});

test("ehFluxoSmartPlusTikTok só aceita o valor gravado pela plataforma", () => {
  expect(ehFluxoSmartPlusTikTok({ tiktok_fluxo: "smart_plus" })).toBe(true);
  expect(ehFluxoSmartPlusTikTok({ tiktok_fluxo: "legado" })).toBe(false);
  expect(ehFluxoSmartPlusTikTok(null)).toBe(false);
});

test("request_id é inteiro de 64 bits em texto", () => {
  for (let i = 0; i < 50; i++) {
    const id = gerarRequestIdTikTok();
    expect(id).toMatch(/^[1-9]\d{0,18}$/);
    expect(BigInt(id) < 2n ** 63n).toBe(true);
  }
  expect(gerarRequestIdTikTok(() => 0.99)).toMatch(/99999$/);
});

test("limparNomeTikTok remove emoji e limita a 512", () => {
  expect(limparNomeTikTok("Campanha 🚀 Leads 👍🏽 SP", "x")).toBe("Campanha Leads SP");
  expect(limparNomeTikTok("🚀", "Padrão")).toBe("Padrão");
  expect(limparNomeTikTok("a".repeat(600), "x")).toHaveLength(512);
});

test("payload da campanha Smart+ segue /smart_plus/campaign/create/", () => {
  expect(montarPayloadCampanhaSmartPlus({ advertiserId: "123", nome: "Leads 🚀", requestId: "999" })).toEqual({
    advertiser_id: "123",
    request_id: "999",
    objective_type: "LEAD_GENERATION",
    campaign_name: "Leads",
    budget_optimize_on: false,
    budget_mode: "BUDGET_MODE_INFINITE",
    operation_status: "ENABLE"
  });
});

describe("agenda", () => {
  test("início/fim chegam em horário de Brasília e vão em UTC", () => {
    const agenda = montarAgendaSmartPlus({
      inicio: "2026-12-10T09:30",
      fim: "2026-12-20T18:00",
      agora: ANTES_DO_CORTE
    });
    expect(agenda).toEqual({
      schedule_start_time: "2026-12-10 12:30:00",
      schedule_type: "SCHEDULE_START_END",
      schedule_end_time: "2026-12-20 21:00:00"
    });
  });

  test("sem início (ou vencido) começa em 1 minuto e roda continuamente", () => {
    const agenda = montarAgendaSmartPlus({ inicio: "2020-01-01T10:00", agora: ANTES_DO_CORTE });
    expect(agenda).toEqual({
      schedule_start_time: "2026-11-05 12:01:00",
      schedule_type: "SCHEDULE_FROM_NOW"
    });
  });
});

describe("grupo de anúncios Smart+", () => {
  const targeting = {
    location_ids: ["3469034"],
    age_groups: ["AGE_25_34"],
    gender: "GENDER_UNLIMITED",
    interest_category_ids: ["15"]
  };

  test("Instant Form", () => {
    const p = montarPayloadAdgroupSmartPlus({
      advertiserId: "123", campaignId: "456", requestId: "789", destino: "lead_ads",
      targeting, orcamentoDiario: 50, agora: ANTES_DO_CORTE, nome: "Grupo"
    });
    expect(p).toEqual({
      advertiser_id: "123",
      campaign_id: "456",
      request_id: "789",
      adgroup_name: "Grupo",
      promotion_type: "LEAD_GENERATION",
      promotion_target_type: "INSTANT_PAGE",
      optimization_goal: "LEAD_GENERATION",
      billing_event: "OCPM",
      bid_type: "BID_TYPE_NO_BID",
      budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET",
      budget: 50,
      schedule_start_time: "2026-11-05 12:01:00",
      schedule_type: "SCHEDULE_FROM_NOW",
      targeting_optimization_mode: "MANUAL",
      targeting_spec: {
        location_ids: ["3469034"],
        age_groups: ["AGE_25_34"],
        gender: "GENDER_UNLIMITED",
        interest_category_ids: ["15"]
      },
      operation_status: "ENABLE"
    });
    expect(p).not.toHaveProperty("placement_type");
    expect(p).not.toHaveProperty("location_ids");
  });

  test("WhatsApp usa phone_info, clique e CPC", () => {
    const p: any = montarPayloadAdgroupSmartPlus({
      advertiserId: "123", campaignId: "456", requestId: "789", destino: "whatsapp",
      targeting, orcamentoDiario: 30, numeroWhatsapp: "21999998888", agora: ANTES_DO_CORTE
    });
    expect(p.promotion_type).toBe("LEAD_GEN_CLICK_TO_SOCIAL_MEDIA_APP_MESSAGE");
    expect(p.messaging_app_type).toBe("WHATSAPP");
    expect(p.phone_info).toEqual({
      phone_region_code: "BR",
      phone_region_calling_code: "+55",
      phone_number: "21999998888"
    });
    expect(p.optimization_goal).toBe("CLICK");
    expect(p.billing_event).toBe("CPC");
    expect(p).not.toHaveProperty("promotion_target_type");
    expect(p).not.toHaveProperty("message_event_set_id");
  });

  test("site otimiza por conversão no evento FORM do Pixel (guia Location as Website)", () => {
    const p: any = montarPayloadAdgroupSmartPlus({
      advertiserId: "123", campaignId: "456", requestId: "789", destino: "site",
      targeting, orcamentoDiario: 40, pixelId: "7311111111111111111", agora: ANTES_DO_CORTE
    });
    expect(p).toMatchObject({
      promotion_type: "LEAD_GENERATION",
      promotion_target_type: "EXTERNAL_WEBSITE",
      optimization_goal: "CONVERT",
      pixel_id: "7311111111111111111",
      optimization_event: "FORM",
      billing_event: "OCPM",
      bid_type: "BID_TYPE_NO_BID",
      budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET",
      budget: 40
    });
    expect(p).not.toHaveProperty("phone_info");
  });

  test("recusa site sem pixel_id numérico e WhatsApp sem número", () => {
    const base = { advertiserId: "1", campaignId: "2", requestId: "3", targeting, orcamentoDiario: 10 };
    expect(() => montarPayloadAdgroupSmartPlus({ ...base, destino: "site" })).toThrow();
    expect(() => montarPayloadAdgroupSmartPlus({ ...base, destino: "site", pixelId: "C4ABCDEF" })).toThrow();
    expect(() => montarPayloadAdgroupSmartPlus({ ...base, destino: "whatsapp" })).toThrow();
  });

  test("targeting_spec omite campos vazios", () => {
    expect(montarTargetingSpecSmartPlus({ location_ids: ["1"] })).toEqual({ location_ids: ["1"] });
  });
});

describe("anúncio Smart+", () => {
  test("Instant Form com identidade do Business Center", () => {
    const p = montarPayloadAnuncioSmartPlus({
      advertiserId: "123", adgroupId: "456", destino: "lead_ads", formId: "PAGE1",
      identidade: identidadeBc, videoId: "v1", capaImageId: "img/capa", texto: "Texto",
      ctaPortfolioId: "CTA1", nome: "Anúncio"
    });
    expect(p).toEqual({
      advertiser_id: "123",
      adgroup_id: "456",
      ad_name: "Anúncio",
      creative_list: [{
        creative_info: {
          ad_format: "SINGLE_VIDEO",
          video_info: { video_id: "v1" },
          image_info: [{ web_uri: "img/capa" }],
          identity_type: "BC_AUTH_TT",
          identity_id: "7000",
          identity_authorized_bc_id: "BC1"
        }
      }],
      ad_text_list: [{ ad_text: "Texto" }],
      page_list: [{ page_id: "PAGE1" }],
      ad_configuration: { call_to_action_id: "CTA1" },
      operation_status: "ENABLE"
    });
  });

  test("WhatsApp não manda page_list nem landing page", () => {
    const p: any = montarPayloadAnuncioSmartPlus({
      advertiserId: "1", adgroupId: "2", destino: "whatsapp",
      identidade: { identity_id: "9", identity_type: "TT_USER" },
      videoId: "v", capaImageId: "c", texto: "", ctaPortfolioId: "CTA"
    });
    expect(p).not.toHaveProperty("page_list");
    expect(p).not.toHaveProperty("landing_page_url_list");
    expect(p.creative_list[0].creative_info).not.toHaveProperty("identity_authorized_bc_id");
    expect(p.ad_text_list[0].ad_text).toBe("Quer mais clientes? 🚀");
  });

  test("site vai em landing_page_url_list, sem page_list", () => {
    const p: any = montarPayloadAnuncioSmartPlus({
      advertiserId: "1", adgroupId: "2", destino: "site", urlSite: "https://corretor.com.br/imovel?x=1",
      identidade: { identity_id: "9", identity_type: "TT_USER" },
      videoId: "v", capaImageId: "c", texto: "t", ctaPortfolioId: "CTA"
    });
    expect(p.landing_page_url_list).toEqual([{ landing_page_url: "https://corretor.com.br/imovel?x=1" }]);
    expect(p).not.toHaveProperty("page_list");
    expect(p.ad_configuration).toEqual({ call_to_action_id: "CTA" });
  });

  test("recusa formulário ausente, site sem URL, CTA ausente e identidade não-Spark", () => {
    const base = {
      advertiserId: "1", adgroupId: "2", identidade: identidadeBc,
      videoId: "v", capaImageId: "c", texto: "t", ctaPortfolioId: "CTA"
    };
    expect(() => montarPayloadAnuncioSmartPlus({ ...base, destino: "lead_ads" })).toThrow();
    expect(() => montarPayloadAnuncioSmartPlus({ ...base, destino: "site" })).toThrow();
    expect(() => montarPayloadAnuncioSmartPlus({ ...base, destino: "site", urlSite: "corretor.com.br" })).toThrow();
    expect(() => montarPayloadAnuncioSmartPlus({ ...base, destino: "whatsapp", ctaPortfolioId: "" })).toThrow();
    expect(() => montarPayloadAnuncioSmartPlus({
      ...base, destino: "whatsapp", identidade: { identity_id: "1", identity_type: "CUSTOMIZED_USER" }
    })).toThrow();
    expect(() => montarCriativoVideoSmartPlus({
      videoId: "v", capaImageId: "", identidade: identidadeBc
    })).toThrow();
  });

  test("erroIdentidadeSmartPlus", () => {
    expect(erroIdentidadeSmartPlus(identidadeBc)).toBeNull();
    expect(erroIdentidadeSmartPlus({ identity_id: "1", identity_type: "TT_USER" })).toBeNull();
    expect(erroIdentidadeSmartPlus({ identity_id: "1", identity_type: "BC_AUTH_TT" })).not.toBeNull();
    expect(erroIdentidadeSmartPlus({ identity_id: "1", identity_type: "AUTH_CODE" })).not.toBeNull();
    expect(erroIdentidadeSmartPlus({ identity_id: "", identity_type: "TT_USER" })).not.toBeNull();
  });

  test("edição só reenvia creative_list quando há criativo novo", () => {
    const semMidia = montarPayloadEdicaoAnuncioSmartPlus({
      advertiserId: "1", smartPlusAdId: "SP1", destino: "lead_ads", texto: "Novo", formId: "PAGE1"
    });
    expect(semMidia).toEqual({
      advertiser_id: "1",
      smart_plus_ad_id: "SP1",
      ad_text_list: [{ ad_text: "Novo" }],
      page_list: [{ page_id: "PAGE1" }]
    });
    const criativo = montarCriativoVideoSmartPlus({ videoId: "v2", capaImageId: "c2", identidade: identidadeBc });
    const comMidia: any = montarPayloadEdicaoAnuncioSmartPlus({
      advertiserId: "1", smartPlusAdId: "SP1", destino: "whatsapp", texto: "Novo", criativo
    });
    expect(comMidia.creative_list).toEqual([criativo]);
    expect(comMidia).not.toHaveProperty("page_list");
    const site: any = montarPayloadEdicaoAnuncioSmartPlus({
      advertiserId: "1", smartPlusAdId: "SP1", destino: "site", texto: "Novo", urlSite: "https://novo.com.br/"
    });
    expect(site.landing_page_url_list).toEqual([{ landing_page_url: "https://novo.com.br/" }]);
  });
});

describe("Pixel da plataforma", () => {
  const lista = {
    code: 0,
    data: {
      pixels: [
        { pixel_id: "111", pixel_code: "CODEOUTRO", pixel_name: "Plataforma de Leads antigo" },
        { pixel_id: "7300000000000000001", pixel_code: "CABC123", pixel_name: "plataforma de leads" }
      ]
    }
  };

  test("acha pelo nome exato ou pelo código", () => {
    expect(pixelDaPlataformaTikTok(lista, { nome: "Plataforma de Leads" }))
      .toEqual({ pixelId: "7300000000000000001", pixelCode: "CABC123" });
    expect(pixelDaPlataformaTikTok(lista, { codigo: "CODEOUTRO" })).toEqual({ pixelId: "111", pixelCode: "CODEOUTRO" });
    expect(pixelDaPlataformaTikTok(lista, { nome: "Outro" })).toBeNull();
    expect(pixelDaPlataformaTikTok({ data: { pixels: [{ pixel_id: "", pixel_code: "X", pixel_name: "a" }] } }, { nome: "a" }))
      .toBeNull();
    expect(pixelDaPlataformaTikTok(null, { nome: "a" })).toBeNull();
  });

  test("erro de permissão do teste real vira texto para o usuário", () => {
    expect(erroPixelTikTok("advertiser does not grant you /pixel/list/:GET permission"))
      .toContain("não liberou o acesso a Pixels");
    expect(erroPixelTikTok("Internal error")).toContain("não foi possível consultar");
  });
});

test("endpoints de status por fluxo", () => {
  expect(endpointsStatusTikTok(true)).toEqual({
    campanha: "/smart_plus/campaign/status/update/",
    adgroup: "/smart_plus/adgroup/status/update/",
    anuncio: "/smart_plus/ad/status/update/",
    chaveAnuncios: "smart_plus_ad_ids"
  });
  expect(endpointsStatusTikTok(false).chaveAnuncios).toBe("ad_ids");
  expect(endpointsStatusTikTok(false).campanha).toBe("/campaign/status/update/");
});

describe("normalização da leitura Smart+", () => {
  test("grupo achata targeting_spec", () => {
    expect(normalizarAdgroupSmartPlus({
      adgroup_id: 11, campaign_id: 22, budget: 50, promotion_type: "LEAD_GENERATION",
      schedule_start_time: "2026-12-10 12:30:00",
      targeting_spec: { location_ids: [3469034], age_groups: ["AGE_25_34"], gender: "GENDER_FEMALE" }
    })).toMatchObject({
      adgroup_id: "11",
      campaign_id: "22",
      budget: 50,
      location_ids: ["3469034"],
      age_groups: ["AGE_25_34"],
      gender: "GENDER_FEMALE",
      interest_category_ids: []
    });
  });

  test("anúncio usa smart_plus_ad_id e não trata a capa como imagem", () => {
    const n = normalizarAnuncioSmartPlus({
      smart_plus_ad_id: "SP1",
      adgroup_id: "11",
      ad_text_list: [{ ad_text: "Olá" }],
      page_list: [{ page_id: "PAGE1" }],
      ad_configuration: { call_to_action_id: "CTA1" },
      creative_list: [{
        material_operation_status: "ENABLE",
        creative_info: {
          ad_format: "SINGLE_VIDEO",
          video_info: { video_id: "v1" },
          image_info: [{ web_uri: "capa1" }],
          identity_type: "BC_AUTH_TT",
          identity_id: "7000",
          identity_authorized_bc_id: "BC1"
        }
      }]
    });
    expect(n).toMatchObject({
      ad_id: "SP1",
      ad_text: "Olá",
      page_id: "PAGE1",
      call_to_action_id: "CTA1",
      identity_type: "BC_AUTH_TT",
      identity_id: "7000",
      identity_authorized_bc_id: "BC1",
      video_id: "v1",
      image_ids: [],
      capa_image_id: "capa1",
      landing_page_url: null
    });
  });
});

function chamadaFalsa(respostas: Array<{ ok: boolean; data: any; error?: string | null }>) {
  const chamadas: Array<{ endpoint: string; opts?: any }> = [];
  const chamar: ChamadaTikTok = async (endpoint, opts) => {
    chamadas.push({ endpoint, opts });
    const r = respostas.shift() ?? { ok: false, data: null, error: "sem resposta" };
    return { ok: r.ok, data: r.data, error: r.error ?? null };
  };
  return { chamar, chamadas };
}

describe("capa do vídeo", () => {
  test("tenta de novo enquanto o vídeo processa e devolve o image ID", async () => {
    const { chamar, chamadas } = chamadaFalsa([
      { ok: false, data: null, error: "video processing" },
      { ok: true, data: { data: { list: [{ id: "tos/capa", url: "http://x" }] } } }
    ]);
    const r = await obterCapaVideoTikTok(chamar, "123", "v1", { intervaloMs: 0 });
    expect(r).toEqual({ ok: true, imageId: "tos/capa" });
    expect(chamadas).toHaveLength(2);
    expect(chamadas[0].endpoint).toBe("/file/video/suggestcover/?advertiser_id=123&video_id=v1&poster_number=1");
  });

  test("desiste depois das tentativas", async () => {
    const { chamar, chamadas } = chamadaFalsa([]);
    const r = await obterCapaVideoTikTok(chamar, "1", "v", { tentativas: 3, intervaloMs: 0 });
    expect(r.ok).toBe(false);
    expect(chamadas).toHaveLength(3);
  });
});

describe("CTA dinâmico", () => {
  // Formato e textos reais de /creative/cta/recommend/ (conta do usuário 15, 2026-11-05).
  const recomendados = {
    data: {
      recommend_assets: [
        { asset_ids: ["201867", "201369"], asset_content: "Tenho interesse" },
        { asset_ids: ["201902", "201404"], asset_content: "Jogar" },
        { asset_ids: [], asset_content: "Saber mais" },
        { asset_ids: ["202114"], asset_content: "Fale conosco" }
      ]
    }
  };

  test("recomenda em português e cria o portfólio CTA", async () => {
    const { chamar, chamadas } = chamadaFalsa([
      { ok: true, data: recomendados },
      { ok: true, data: { data: { creative_portfolio_id: "P1" } } }
    ]);
    const r = await criarPortfolioCtaDinamicoTikTok(chamar, {
      advertiserId: "123",
      promotionType: "LEAD_GEN_CLICK_TO_SOCIAL_MEDIA_APP_MESSAGE",
      optimizationGoal: "CLICK"
    });
    expect(r).toEqual({ ok: true, portfolioId: "P1", ctas: ["Tenho interesse", "Fale conosco"] });
    const params = new URLSearchParams(chamadas[0].endpoint.split("?")[1]);
    expect(chamadas[0].endpoint.startsWith("/creative/cta/recommend/?")).toBe(true);
    expect(params.get("new_version")).toBe("true");
    expect(params.get("objective_type")).toBe("LEAD_GENERATION");
    expect(params.get("promotion_type")).toBe("LEAD_GEN_CLICK_TO_SOCIAL_MEDIA_APP_MESSAGE");
    expect(params.get("language")).toBe("pt");
    expect(chamadas[1]).toEqual({
      endpoint: "/creative/portfolio/create/",
      opts: {
        method: "POST",
        body: {
          advertiser_id: "123",
          creative_portfolio_type: "CTA",
          portfolio_content: [
            { asset_content: "Tenho interesse", asset_ids: ["201867", "201369"] },
            { asset_content: "Fale conosco", asset_ids: ["202114"] }
          ]
        }
      }
    });
  });

  test("sem recomendação em português, tenta o idioma padrão", async () => {
    const { chamar, chamadas } = chamadaFalsa([
      { ok: false, data: null, error: "invalid language" },
      { ok: true, data: recomendados },
      { ok: true, data: { data: { creative_portfolio_id: "P2" } } }
    ]);
    const r = await criarPortfolioCtaDinamicoTikTok(chamar, {
      advertiserId: "1", promotionType: "LEAD_GENERATION", optimizationGoal: "LEAD_GENERATION"
    });
    expect(r).toMatchObject({ ok: true, portfolioId: "P2" });
    expect(new URLSearchParams(chamadas[1].endpoint.split("?")[1]).has("language")).toBe(false);
  });

  test("falha clara quando o portfólio não é criado", async () => {
    const { chamar } = chamadaFalsa([
      { ok: true, data: recomendados },
      { ok: false, data: null, error: "permission denied" }
    ]);
    const r = await criarPortfolioCtaDinamicoTikTok(chamar, {
      advertiserId: "1", promotionType: "LEAD_GENERATION", optimizationGoal: "LEAD_GENERATION"
    });
    expect(r).toEqual({ ok: false, erro: "permission denied" });
  });

  test("montarConteudoPortfolioCta descarta itens sem ID ou texto", () => {
    expect(montarConteudoPortfolioCta([{ asset_content: "", asset_ids: ["1"] }, null as any])).toEqual([]);
  });

  test("portfólio fica só com botões de lead, em pt ou inglês", () => {
    const pt = montarConteudoPortfolioCta([
      { asset_content: "Instalar agora", asset_ids: ["1"] },
      { asset_content: "Enviar mensagem", asset_ids: ["2"] },
      { asset_content: "Obter ingressos agora", asset_ids: ["3"] },
      { asset_content: "Cadastre-se", asset_ids: ["4"] }
    ]);
    expect(pt.map(c => c.asset_content)).toEqual(["Enviar mensagem", "Cadastre-se"]);
    const en = montarConteudoPortfolioCta([
      { asset_content: "Play game", asset_ids: ["1"] },
      { asset_content: "Learn more", asset_ids: ["2"] }
    ]);
    expect(en.map(c => c.asset_content)).toEqual(["Learn more"]);
  });

  test("sem nenhum botão de lead conhecido, usa a recomendação inteira", () => {
    const todos = montarConteudoPortfolioCta([
      { asset_content: "Novo texto do TikTok", asset_ids: ["1"] },
      { asset_content: "Outro", asset_ids: ["2"] }
    ]);
    expect(todos).toHaveLength(2);
  });
});

test("traduz o erro de pagamento do TikTok", () => {
  expect(traduzirErroPublicacaoTikTok(
    "Your account has an outstanding payment or no valid payment method. Check your billing settings to continue."
  )).toContain("forma de pagamento");
  expect(traduzirErroPublicacaoTikTok("Invalid campaign name")).toBeNull();
  expect(traduzirErroPublicacaoTikTok(null)).toBeNull();
});
