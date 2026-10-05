import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { decidirOtimizacaoSiteMeta, dominioDoReferer } from "./site-captura";

test("campanha direto para o site só otimiza por lead com o código instalado", () => {
  const agora = new Date("2026-09-30T12:00:00Z");
  expect(decidirOtimizacaoSiteMeta({ temRecursoEventos: true, codigoVistoEm: "2026-09-29T10:00:00Z", agora }).otimizacao).toBe("lead");
  expect(decidirOtimizacaoSiteMeta({ temRecursoEventos: true, ultimoLeadSiteEm: "2026-09-10T10:00:00Z", agora }).otimizacao).toBe("lead");
  expect(decidirOtimizacaoSiteMeta({ temRecursoEventos: true, codigoVistoEm: "2026-08-01T10:00:00Z", agora })).toEqual({
    otimizacao: "visitas", motivo: "código do formulário ainda não detectado no site"
  });
  expect(decidirOtimizacaoSiteMeta({ temRecursoEventos: true, agora }).otimizacao).toBe("visitas");
  expect(decidirOtimizacaoSiteMeta({ temRecursoEventos: false, codigoVistoEm: "2026-09-29T10:00:00Z", agora }).otimizacao).toBe("visitas");
  expect(decidirOtimizacaoSiteMeta({ temRecursoEventos: true, codigoVistoEm: "lixo", agora }).otimizacao).toBe("visitas");
});

test("domínio do site pela página que carregou o script", () => {
  expect(dominioDoReferer("https://www.CasaVerde.com.br/lancamento?fbclid=x")).toBe("www.casaverde.com.br");
  expect(dominioDoReferer("")).toBeNull();
  expect(dominioDoReferer(undefined)).toBeNull();
  expect(dominioDoReferer("javascript:alert(1)")).toBeNull();
});

import { botaoFinalFormularioMeta, detectarRedeSite, montarFbc, normalizarAtribuicao, scriptFormularioSite, validarEnvioSite } from "./site-captura";

test("botão final do formulário da Meta leva ao site do corretor", () => {
  // "Formulário + botão para o seu site": o link do site vai no botão.
  expect(botaoFinalFormularioMeta({ site_via_formulario: true, link: "https://casaverde.com.br/lancamento" }))
    .toEqual({ website_url: "https://casaverde.com.br/lancamento", button_text: "Visitar site" });
  // Link próprio do botão e texto escolhido prevalecem.
  expect(botaoFinalFormularioMeta({ obrigado_url: "https://x.com.br/obrigado", obrigado_botao: "Ver imóveis", link: "https://y.com" }))
    .toEqual({ website_url: "https://x.com.br/obrigado", button_text: "Ver imóveis" });
  // Sem link: site do anunciante pela política de privacidade (antes ia pra google.com).
  expect(botaoFinalFormularioMeta({ privacidade_url: "https://casaverde.com.br/privacidade" }))
    .toEqual({ website_url: "https://casaverde.com.br/", button_text: "Ver mais" });
  expect(botaoFinalFormularioMeta({ url_privacidade: "https://casaverde.com.br/p" }).website_url).toBe("https://casaverde.com.br/");
  // link sem a marca de "formulário + site" não vira botão (campanha de formulário comum).
  expect(botaoFinalFormularioMeta({ link: "https://y.com", privacidade_url: "https://z.com/p" }).website_url).toBe("https://z.com/");
  expect(botaoFinalFormularioMeta({ obrigado_url: "javascript:alert(1)" }).website_url).toBe("https://google.com");
  expect(botaoFinalFormularioMeta({}).website_url).toBe("https://google.com");
});
import { idEventoSiteMeta, montarEventoMeta } from "./eventos-meta";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

test("rede pelo identificador do clique; utm_source só na falta dele", () => {
  expect(detectarRedeSite({ gclid: "x" })).toBe("google");
  expect(detectarRedeSite({ wbraid: "x" })).toBe("google");
  expect(detectarRedeSite({ fbclid: "x" })).toBe("meta");
  expect(detectarRedeSite({ fbc: "fb.1.1.x" })).toBe("meta");
  expect(detectarRedeSite({ ttclid: "x" })).toBe("tiktok");
  expect(detectarRedeSite({ li_fat_id: "x" })).toBe("linkedin");
  expect(detectarRedeSite({ utm_source: "Instagram" })).toBe("meta");
  expect(detectarRedeSite({ utm_source: "google" })).toBe("google");
  expect(detectarRedeSite({ utm_source: "newsletter" })).toBe("site");
  expect(detectarRedeSite({})).toBe("site");
  // identificador vence utm divergente
  expect(detectarRedeSite({ gclid: "x", utm_source: "facebook" })).toBe("google");
});

test("atribuição: só chaves conhecidas, texto curto, sem caractere de controle", () => {
  const atr = normalizarAtribuicao({ fbclid: "abc\n", utm_campaign: "x".repeat(400), hack: "<script>", pagina: "https://site.com/lp" });
  expect(atr).toEqual({ fbclid: "abc", utm_campaign: "x".repeat(300), pagina: "https://site.com/lp" });
  expect(normalizarAtribuicao("lixo")).toEqual({});
  expect(montarFbc("abc", 1700000000000)).toBe("fb.1.1700000000000.abc");
});

test("validação do envio do formulário", () => {
  expect(validarEnvioSite({ nome: "Ana Souza", telefone: "(11) 98765-4321", email: "ANA@X.COM " })).toEqual({
    ok: true, dados: { nome: "Ana Souza", telefone: "11987654321", email: "ana@x.com", mensagem: null }
  });
  expect(validarEnvioSite({ nome: "A", telefone: "11987654321" }).erro).toBe("Informe seu nome.");
  expect(validarEnvioSite({ nome: "Ana", telefone: "98765" }).erro).toBe("Informe um telefone com DDD.");
  expect(validarEnvioSite({ nome: "Ana", telefone: "11987654321", email: "nao-e-email" }).erro).toBe("E-mail inválido.");
});

test("script do formulário é JavaScript válido e usa a rota pública", () => {
  const js = scriptFormularioSite();
  expect(() => new Function(js)).not.toThrow();
  expect(js).toContain("/site/leads");
  expect(js).toContain("PlataformaLeads");
});

test("evento de site da Meta: Lead na chegada (site), venda como Purchase (sistema)", () => {
  const lead = {
    id: 42, plataforma: "site", origem: "meta", email: " Ana@X.com ", telefone: "11987654321",
    atribuicao: { fbc: "fb.1.1.abc", fbp: "fb.1.2.3", ip: "200.1.2.3", user_agent: "Mozilla", pagina: "https://site.com/lp" }
  };
  expect(montarEventoMeta({ lead, etapa: "Lead", agoraSegundos: 10 })).toEqual({
    event_name: "Lead",
    event_time: 10,
    event_id: "lead-42-lead",
    action_source: "website",
    event_source_url: "https://site.com/lp",
    user_data: {
      em: [sha("ana@x.com")],
      ph: [sha("5511987654321")],
      external_id: [sha("lead-42")],
      fbc: "fb.1.1.abc",
      fbp: "fb.1.2.3",
      client_ip_address: "200.1.2.3",
      client_user_agent: "Mozilla"
    }
  });
  const venda = montarEventoMeta({ lead: { ...lead, valor_negocio: "1500.00" }, etapa: "Closed Won", agoraSegundos: 10 });
  expect(venda.event_name).toBe("Purchase");
  expect(venda.action_source).toBe("system_generated");
  expect(venda.custom_data).toEqual({ currency: "BRL", value: 1500 });
  expect(venda.event_source_url).toBeUndefined();
  expect(montarEventoMeta({ lead: { ...lead, atribuicao: JSON.stringify(lead.atribuicao) }, etapa: "Qualified Lead", agoraSegundos: 1 }).user_data.fbc).toBe("fb.1.1.abc");
  expect(idEventoSiteMeta(42, "Lead")).toBe("lead-42-lead");
  expect(() => montarEventoMeta({ lead: { lead_id: "1" }, etapa: "Lead" })).toThrow();
});

import { extrairSendToGoogle, validarSendToGoogle } from "./site-captura";

test("tag do Google: send_to lido do trecho de evento da API, formato estrito", () => {
  // Formato real de conversion_action.tag_snippets (conferência 05/10/2026).
  const snippets = [
    { type: "WEBPAGE_ONCLICK", pageFormat: "HTML", eventSnippet: "<script>function gtag_report_conversion(url) {}</script>" },
    { type: "WEBPAGE", pageFormat: "HTML", eventSnippet: "<!-- Event snippet -->\n<script>\n  gtag('event', 'conversion', {'send_to': 'AW-16773309415/AbC-d_9xyz'});\n</script>\n" }
  ];
  expect(extrairSendToGoogle(snippets)).toBe("AW-16773309415/AbC-d_9xyz");
  expect(extrairSendToGoogle([])).toBeNull();
  expect(extrairSendToGoogle(undefined)).toBeNull();
  expect(validarSendToGoogle("AW-123/abc\"};alert(1)//")).toBeNull();
  expect(validarSendToGoogle("G-ABC123/xyz1")).toBeNull();
});

test("script com a tag do Google: carrega só para quem veio do Google e registra a conversão no envio", async () => {
  const js = scriptFormularioSite({ googleSendTo: "AW-16773309415/AbC-d_9xyz" });
  expect(() => new Function(js)).not.toThrow();
  expect(js).toContain('var GOOGLE_SEND_TO = "AW-16773309415/AbC-d_9xyz";');
  // send_to inválido não entra no script.
  expect(scriptFormularioSite({ googleSendTo: "AW-1/x'};alert(1)//" })).toContain('var GOOGLE_SEND_TO = "";');

  // Simula a página: chegada com gclid, envio do formulário próprio.
  const rodar = async (url: string, opcoes: { semGoogle?: boolean; armazenado?: any } = {}) => {
    const loja: Record<string, string> = {};
    if (opcoes.armazenado) loja.plataforma_leads_origem = JSON.stringify(opcoes.armazenado);
    const scriptsAdicionados: string[] = [];
    const chamadasGtag: any[] = [];
    const attrs: Record<string, string> = { "data-sem-formulario": "" };
    if (opcoes.semGoogle) attrs["data-sem-google"] = "";
    const window: any = {};
    const document: any = {
      currentScript: {
        src: "https://api.exemplo.com/site/form.js?k=chave",
        hasAttribute: (n: string) => n in attrs,
        getAttribute: (n: string) => attrs[n] ?? null
      },
      cookie: "",
      referrer: "",
      querySelector: () => null,
      createElement: () => ({}),
      head: { appendChild: (el: any) => scriptsAdicionados.push(el.src) }
    };
    const localStorage = { getItem: (k: string) => loja[k] ?? null, setItem: (k: string, v: string) => { loja[k] = v; } };
    const location = new URL(url);
    const fetch = async () => ({ ok: true, json: async () => ({ ok: true, event_id: "lead-7-lead" }) });
    new Function("window", "document", "localStorage", "location", "fetch", js)(window, document, localStorage, location, fetch);
    if (typeof window.gtag === "function") {
      const original = window.dataLayer;
      window.dataLayer = { push: (a: any) => { chamadasGtag.push(Array.from(a)); original.push(a); } };
    }
    await window.PlataformaLeads.enviar({ nome: "Ana", telefone: "11987654321" });
    return { scriptsAdicionados, chamadasGtag, window };
  };

  const doGoogle = await rodar("https://site.com/lp?gclid=abc");
  expect(doGoogle.scriptsAdicionados).toEqual(["https://www.googletagmanager.com/gtag/js?id=AW-16773309415"]);
  expect(doGoogle.window.dataLayer).toBeDefined();
  expect(doGoogle.chamadasGtag).toEqual([["event", "conversion", { send_to: "AW-16773309415/AbC-d_9xyz", transaction_id: "lead-7-lead" }]]);

  // Voltou outro dia, sem gclid na URL: usa o clique guardado.
  const volta = await rodar("https://site.com/contato", { armazenado: { gclid: "abc", capturado_em: Date.now() - 86_400_000 } });
  expect(volta.chamadasGtag.length).toBe(1);

  // Orgânico (sem clique do Google) e opt-out: nada do Google.
  const organico = await rodar("https://site.com/lp?fbclid=x");
  expect(organico.scriptsAdicionados).toEqual([]);
  expect(organico.window.gtag).toBeUndefined();
  const optOut = await rodar("https://site.com/lp?gclid=abc", { semGoogle: true });
  expect(optOut.window.gtag).toBeUndefined();
  // Clique guardado há mais de 90 dias não conta.
  const velho = await rodar("https://site.com/lp", { armazenado: { gclid: "abc", capturado_em: Date.now() - 91 * 86_400_000 } });
  expect(velho.window.gtag).toBeUndefined();
});
