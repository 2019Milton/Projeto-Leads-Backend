import { describe, expect, test } from "bun:test";
import { consultarRedesMeta, contarCampanhasPorRedeMeta, montarEvidenciasRedesMeta, redesCampanhaPainelMeta } from "./redes-meta";

const campanha = (cfg: any, status = "ACTIVE", campaign_id = "421") => ({
  campaign_id, status, configuracoes_avancadas: cfg
});
const linha = (rede: string, impressions = "1", campaign_id = "421") => ({
  campaign_id, publisher_platform: rede, impressions, date_start: "2026-09-25", date_stop: "2026-09-25"
});
const conjunto = (redes?: string[], campaign_id = "421") => ({
  campaign_id, effective_status: "ACTIVE", targeting: { publisher_platforms: redes }
});
const cfgEvidencia = (conjuntos: any[], insights: any[]) => ({
  redes_identificadas_meta: montarEvidenciasRedesMeta(["421"], conjuntos, insights).get("421")
});

describe("campanhas Meta por rede", () => {
  test("regressão suplementos: sem targeting, entrega nas duas redes", () => {
    const cfg = cfgEvidencia([conjunto()], [linha("facebook"), linha("instagram")]);
    const resultado = contarCampanhasPorRedeMeta([
      campanha(cfg), campanha({ plataformas: ["facebook"] }, "ACTIVE", "alice")
    ]);
    expect(resultado).toEqual({ por_rede: {
      facebook: { campanhas: 2, campanhas_ativas: 2 },
      instagram: { campanhas: 1, campanhas_ativas: 1 }
    }, sem_rede_identificada: 0 });
    expect(cfg).not.toHaveProperty("plataformas");
  });
  test("conta combinadas uma vez por rede e preserva ativas/pausadas", () => {
    expect(contarCampanhasPorRedeMeta([
      campanha({ plataformas: ["facebook", "FACEBOOK", "instagram"] }, "PAUSED"),
      campanha(JSON.stringify({ plataformas: ["instagram"] }), "ENABLED")
    ]).por_rede).toEqual({
      facebook: { campanhas: 1, campanhas_ativas: 0 },
      instagram: { campanhas: 2, campanhas_ativas: 1 }
    });
  });
  test("sem informação não adivinha; ignora redes alheias e JSON inválido", () => {
    expect(contarCampanhasPorRedeMeta([campanha(null), campanha("{invalido"),
      campanha({ plataformas: ["messenger"] })]).sem_rede_identificada).toBe(3);
  });
  test("configuração atual completa prevalece sobre entrega histórica", () => {
    const cfg = cfgEvidencia([conjunto(["facebook"])], [linha("instagram")]);
    expect(redesCampanhaPainelMeta(campanha(cfg))).toEqual(["facebook"]);
  });
  test("união de todos os conjuntos, sem archived/deleted ou outra campanha", () => {
    const cfg = cfgEvidencia([conjunto(["facebook"]), conjunto(["instagram"]),
      conjunto(["facebook"], "outra")], []);
    expect(redesCampanhaPainelMeta(campanha(cfg))).toEqual(["facebook", "instagram"]);
    const excluidos = cfgEvidencia([conjunto(["facebook"]),
      { ...conjunto(["instagram"]), effective_status: "ARCHIVED" }], []);
    expect(redesCampanhaPainelMeta(campanha(excluidos))).toEqual(["facebook"]);
  });
  test("targeting parcial usa entrega e ignora impressão zero", () => {
    const cfg = cfgEvidencia([conjunto(["facebook"]), conjunto()],
      [linha("instagram"), linha("facebook", "0", "outra")]);
    expect(redesCampanhaPainelMeta(campanha(cfg))).toEqual(["facebook", "instagram"]);
    expect(redesCampanhaPainelMeta(campanha(cfgEvidencia([], [linha("instagram", "0")])))).toEqual([]);
  });
  test("evidência copiada de outra campanha não é usada", () => {
    const cfg = cfgEvidencia([], [linha("instagram")]);
    expect(redesCampanhaPainelMeta(campanha(cfg, "ACTIVE", "duplicada"))).toEqual([]);
  });
  test("posicionamentos efetivos e plataformas fora do painel", () => {
    const cfg = cfgEvidencia([{ campaign_id: "421", targeting: {
      effective_publisher_platforms: ["instagram"]
    } }], []);
    expect(redesCampanhaPainelMeta(campanha(cfg))).toEqual(["instagram"]);
    const somenteMessenger = cfgEvidencia([conjunto(["messenger"])], [linha("facebook")]);
    expect(redesCampanhaPainelMeta(campanha(somenteMessenger))).toEqual([]);
  });
});

describe("consulta à Meta", () => {
  test("pagina conjuntos e insights e inclui entrega de hoje", async () => {
    const urls: URL[] = [];
    const respostas = [
      { data: [conjunto(["facebook"])], paging: { next: "https://graph.facebook.com/v19.0/act_1/adsets?after=next" } },
      { data: [conjunto()] },
      { data: [linha("facebook")], paging: { next: "https://graph.facebook.com/v19.0/act_1/insights?after=next" } },
      { data: [] }, { data: [linha("instagram")] }
    ];
    const mock = (async (url: any, options: any) => {
      urls.push(new URL(url));
      expect(options.headers.Authorization).toBe("Bearer segredo");
      expect(options.method).toBeUndefined();
      return Response.json(respostas.shift());
    }) as typeof fetch;
    const resultado = await consultarRedesMeta("segredo", "act_1", ["421"], mock);
    expect(resultado.get("421")?.com_entrega).toEqual(["facebook", "instagram"]);
    expect(urls[2].searchParams.get("date_preset")).toBe("last_30d");
    expect(urls[4].searchParams.get("date_preset")).toBe("today");
  });
  test("não produz resultado parcial em erro da API", async () => {
    let chamadas = 0;
    const mock = (async () => Response.json(++chamadas === 1
      ? { data: [conjunto()] } : { error: { message: "segredo" } })) as typeof fetch;
    await expect(consultarRedesMeta("segredo", "act_1", ["421"], mock)).rejects.toThrow("Falha ao consultar redes Meta");
  });
  test("não envia token a host de paginação inesperado", async () => {
    const mock = (async () => Response.json({ data: [], paging: { next: "https://example.com" } })) as typeof fetch;
    await expect(consultarRedesMeta("segredo", "act_1", ["421"], mock)).rejects.toThrow("Paginação");
  });
});
