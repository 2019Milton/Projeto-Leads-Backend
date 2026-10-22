import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

// Executa o handler e o construtor reais, sem iniciar servidor, cron ou banco.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const transpiler = new Bun.Transpiler({ loader: "ts" });
function extract(start: string, end: string) {
  const i = source.indexOf(start);
  if (i < 0 || source.indexOf(end, i) < 0) throw new Error("Trecho não encontrado");
  return source.slice(i, source.indexOf(end, i));
}
const creativeCode = extract("function montarConteudoCriativoMeta(", "async function registrarErroPublicacaoCampanha(");
const routeCode = extract('app.post("/meta/anuncio",', "app.get(");

async function run(options: any = {}) {
  let handler: any;
  const updates: any[] = [], requests: any[] = [];
  const env: any = {
    app: { post: (_p: any, _m: any, h: any) => handler = h },
    authMiddleware: () => {},
    resolverUsuarioIdOperacao: () => options.denied ? null : 1,
    negarAcessoConta: (c: any) => c.json({ error: "negado" }, 403),
    resolverDestinoCampanha: () => "lead_ads",
    client: { query: async (sql: string, values: any[]) => {
      if (sql.includes("UPDATE campanhas")) {
        updates.push({ sql, values });
        if (options.dbError) throw new Error("private database detail");
        return { rowCount: options.zeroRows ? 0 : 1 };
      }
      if (!sql.includes("FROM meta_conexoes")) throw new Error("Consulta inesperada");
      return { rows: [{ access_token: "fixture-only", conta_anuncios_id: "act_fixture" }] };
    } },
    obterContaAnuncios: async () => ({ id: "act_fixture" }),
    campanhaExisteNaContaSelecionada: async () => true,
    urlOpcional: (x: any, f: any) => x || f,
    textoOpcional: (x: any) => x || null,
    numeroOpcional: (x: any) => x == null ? null : Number(x),
    montarCallToActionMeta: () => ({}),
    aguardarVideoMetaReady: async () => ({ picture: "https://example.com/thumbnail.jpg" }),
    listarContasInstagramAnuncio: async () => [{ id: "ig_fixture" }],
    console: { log() {}, warn() {}, error() {} },
    fetch: async (url: string, init: any) => {
      requests.push({ url, body: JSON.parse(init.body) });
      if (url.endsWith("/adcreatives")) return { json: async () => ({ id: "creative_fixture" }) };
      if (options.timeout) throw new Error("timeout");
      return { json: async () => {
        if (options.invalidJson) throw new SyntaxError("Invalid JSON");
        return options.ad ?? { id: "ad_fixture" };
      } };
    }
  };
  new Function(...Object.keys(env), transpiler.transformSync(creativeCode + routeCode))(...Object.values(env));
  const result = await handler({
    get: () => ({ id: 1 }),
    req: { json: async () => ({ campaign_id: "campaign_fixture", adset_id: "adset_fixture", page_id: "page_fixture", form_id: "form_fixture", imageHashes: ["hash1"], ...options.body }) },
    json: (body: any, status = 200) => ({ body, status })
  });
  return { ...result, updates, requests };
}

for (const [name, body, tipo] of [
  ["imagem", {}, "imagem"],
  ["carrossel imagens", { imageHashes: ["h1", "h2"] }, "carrossel"],
  ["vídeo", { imageHashes: [], video_id: "video_fixture" }, "video"],
  ["carrossel misto", { video_id: "video_fixture" }, "carrossel"],
  ["Instagram imagens", { video_id: "video_fixture", imageHashes: ["h1", "h2"], configuracoes_avancadas: { plataformas: ["instagram"], escolha_midia_instagram: "imagens" } }, "carrossel"],
  ["Instagram vídeo", { video_id: "video_fixture", configuracoes_avancadas: { plataformas: ["instagram"], escolha_midia_instagram: "video" } }, "video"]
] as const) {
  test(`persiste confirmação e formato real: ${name}`, async () => {
    const r = await run({ body });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe("ad_fixture");
    expect(r.updates).toHaveLength(1);
    const saved = JSON.parse(r.updates[0].values[5]);
    expect(saved.criativo.tipo).toBe(tipo);
    expect(saved.criativo_tipo).toBe(tipo);
    expect(saved.criativo.carrossel).toBe(tipo === "carrossel");
    expect(r.updates[0].sql).toContain("AND usuario_id = $8");
    expect(r.updates[0].values.slice(-2)).toEqual(["campaign_fixture", 1]);
  });
}

test("falta de pagamento persiste configuração sem confirmar anúncio ativo", async () => {
  const r = await run({ ad: { error: { error_subcode: 1359188 } } });
  expect(r.status).toBe(200);
  expect(r.body.sem_forma_pagamento).toBe(true);
  expect(r.body.id).toBeUndefined();
  expect(JSON.parse(r.updates[0].values[4]).criativo.tipo).toBe("imagem");
});

for (const failure of [{ dbError: true }, { zeroRows: true }]) {
  test(`anúncio criado + falha local preserva IDs: ${JSON.stringify(failure)}`, async () => {
    const r = await run(failure);
    expect(r.status).toBe(500);
    expect(r.body.ad_id).toBe("ad_fixture");
    expect(r.body.anuncio_criado).toBe(true);
    expect(r.body.preservar_campanha).toBe(true);
    expect(r.body.campaign_id).toBe("campaign_fixture");
    expect(JSON.stringify(r.body)).not.toContain("private database");
  });
}
for (const failure of [{ timeout: true }, { invalidJson: true }, { ad: {} }]) {
  test(`resposta incerta não declara sucesso: ${JSON.stringify(failure)}`, async () => {
    const r = await run(failure);
    expect(r.status).toBe(500);
    expect(r.body.publicacao_pendente).toBe(true);
    expect(r.body.anuncio_criado).toBe(false);
    expect(r.updates).toHaveLength(0);
  });
}
test("rejeição Meta informa motivo", async () => {
  const r = await run({ ad: { error: { code: 100, error_user_msg: "Revise o destino" } } });
  expect(r.status).toBe(400);
  expect(r.body.error).toBe("Revise o destino");
  expect(r.body.codigo_meta).toBe(100);
});
test("falha ao salvar pendência de pagamento não indica sucesso", async () => {
  const r = await run({ zeroRows: true, ad: { error: { error_subcode: 1359188 } } });
  expect(r.status).toBe(500);
  expect(r.body.preservar_campanha).toBe(true);
  expect(r.body.sem_forma_pagamento).toBeUndefined();
});
test("sem autorização não chama Meta", async () => {
  const r = await run({ denied: true });
  expect(r.status).toBe(403);
  expect(r.requests).toHaveLength(0);
});
