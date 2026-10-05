import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { calcularScoreLead, detectarChaveNicho } from "./score-lead";

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("Faculdade/Universidade e Dentista existem no catalogo e no score", () => {
  expect(indexSource).toContain("('faculdade_universidade','Faculdade / Universidade'");
  expect(indexSource).toContain("('dentista',     'Dentista'");
  expect(detectarChaveNicho({ nicho_slug: "faculdade_universidade" })).toBe("faculdade_universidade");
  expect(detectarChaveNicho({ nicho_slug: "dentista" })).toBe("dentista");

  const faculdade = calcularScoreLead({
    nicho_slug: "faculdade_universidade",
    nicho_nome: "Faculdade / Universidade",
    whatsapp_transcricao_cliente: "quero saber sobre vestibular e matricula"
  });
  expect(faculdade.base.some((linha: string) => linha.includes("Faculdade / Universidade"))).toBe(true);

  const dentista = calcularScoreLead({
    nicho_slug: "dentista",
    nicho_nome: "Dentista",
    whatsapp_transcricao_cliente: "quero agendar avaliacao para implante"
  });
  expect(dentista.base.some((linha: string) => linha.includes("Dentista"))).toBe(true);
});

test("criador IA aceita as cinco plataformas disponiveis", () => {
  expect(indexSource).toContain(
    'new Set(["meta", "facebook", "instagram", "tiktok", "google", "linkedin"])'
  );

  for (const campo of [
    "nicho_curso_interesse",
    "nicho_modalidade_faculdade",
    "nicho_turno_faculdade",
    "nicho_tipo_ingresso",
    "nicho_cidade_campus",
    "nicho_publico_alvo_faculdade",
    "nicho_tratamento_dentista",
    "nicho_tipo_atendimento_dentista",
    "nicho_regiao_dentista",
    "nicho_forma_atendimento_dentista",
    "nicho_publico_alvo_dentista"
  ]) {
    expect(indexSource).toContain(campo);
  }
});

test("rascunho multiplataforma e local e suporta Facebook Instagram Google TikTok e LinkedIn", () => {
  const inicio = indexSource.indexOf('app.post("/campanhas/:id/rascunhos-plataformas"');
  const fim = indexSource.indexOf('app.post("/campanhas/:id/reverter-publicacao-rascunho"', inicio);
  expect(inicio).toBeGreaterThan(-1);
  expect(fim).toBeGreaterThan(inicio);

  const rota = indexSource.slice(inicio, fim);
  expect(rota).toContain('new Set(["facebook", "instagram", "google", "tiktok", "linkedin"])');
  expect(rota).toContain("rascunhos.length > 5");
  expect(rota).toContain("campaign_id, adset_id, ad_id, form_id, conta_anuncios_id");
  expect(rota).toContain("NULL,NULL,NULL,NULL,NULL");
  expect(rota).not.toContain("await fetch(");
  expect(rota).not.toContain("graph.facebook.com");
  expect(rota).not.toContain("googleAds");
  expect(rota).not.toContain("linkedinFetch");
  expect(rota).not.toContain("tiktokFetch");
});
