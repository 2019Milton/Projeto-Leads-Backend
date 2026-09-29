import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { detectarRedeSite, montarFbc, normalizarAtribuicao, scriptFormularioSite, validarEnvioSite } from "./site-captura";
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
