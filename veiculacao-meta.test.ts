import { describe, expect, test } from "bun:test";
import {
  descreverConjuntosPausados,
  resolverVeiculacaoPorCampanha,
  rotuloVeiculacao,
  veiculacaoParcial,
  type AnuncioMeta,
} from "./veiculacao-meta";

const ad = (campaign_id: string, adset_id: string | null, effective_status: string): AnuncioMeta => ({
  campaign_id,
  adset_id,
  effective_status,
});

describe("resolverVeiculacaoPorCampanha", () => {
  test("conjunto único pausado: campanha ligada, mas sem veicular", () => {
    const r = resolverVeiculacaoPorCampanha([
      ad("c1", "s1", "ADSET_PAUSED"),
      ad("c1", "s1", "ADSET_PAUSED"),
    ]);
    expect(r.c1).toEqual({
      status: "ADSET_PAUSED",
      semVeicular: true,
      conjuntos: { total: 1, ativos: 0, pausados: 1 },
    });
  });

  test("vários conjuntos, alguns pausados: a campanha está veiculando (parcial)", () => {
    const r = resolverVeiculacaoPorCampanha([
      ad("c1", "s1", "ACTIVE"),
      ad("c1", "s2", "ADSET_PAUSED"),
      ad("c1", "s3", "ADSET_PAUSED"),
    ]);
    expect(r.c1).toEqual({
      status: "ACTIVE",
      semVeicular: false,
      conjuntos: { total: 3, ativos: 1, pausados: 2 },
    });
    expect(veiculacaoParcial(r.c1)).toBe(true);
  });

  test("todos os conjuntos pausados continua sendo sem veicular", () => {
    const r = resolverVeiculacaoPorCampanha([
      ad("c1", "s1", "ADSET_PAUSED"),
      ad("c1", "s2", "ADSET_PAUSED"),
    ]);
    expect(r.c1!.semVeicular).toBe(true);
    expect(r.c1!.conjuntos).toEqual({ total: 2, ativos: 0, pausados: 2 });
    expect(veiculacaoParcial(r.c1)).toBe(false);
  });

  test("tudo ativo: sem aviso", () => {
    const r = resolverVeiculacaoPorCampanha([ad("c1", "s1", "ACTIVE"), ad("c1", "s2", "ACTIVE")]);
    expect(r.c1).toEqual({
      status: "ACTIVE",
      semVeicular: false,
      conjuntos: { total: 2, ativos: 2, pausados: 0 },
    });
    expect(veiculacaoParcial(r.c1)).toBe(false);
  });

  test("anúncio pausado individualmente convive com outro ativo: veiculando", () => {
    const r = resolverVeiculacaoPorCampanha([ad("c1", "s1", "PAUSED"), ad("c1", "s1", "ACTIVE")]);
    expect(r.c1!.status).toBe("ACTIVE");
    expect(r.c1!.semVeicular).toBe(false);
    expect(r.c1!.conjuntos).toEqual({ total: 1, ativos: 1, pausados: 0 });
  });

  test("todos os anúncios pausados: sem veicular (o conjunto está ligado)", () => {
    const r = resolverVeiculacaoPorCampanha([ad("c1", "s1", "PAUSED"), ad("c1", "s1", "PAUSED")]);
    expect(r.c1!.status).toBe("PAUSED");
    expect(r.c1!.semVeicular).toBe(true);
    expect(r.c1!.conjuntos).toEqual({ total: 1, ativos: 0, pausados: 0 });
  });

  test("problema de aprovação ou cobrança continua aparecendo mesmo com anúncio ativo", () => {
    expect(resolverVeiculacaoPorCampanha([ad("c1", "s1", "ACTIVE"), ad("c1", "s2", "DISAPPROVED")]).c1!.status).toBe("DISAPPROVED");
    expect(resolverVeiculacaoPorCampanha([ad("c1", "s1", "ACTIVE"), ad("c1", "s2", "WITH_ISSUES")]).c1!.status).toBe("WITH_ISSUES");
    expect(resolverVeiculacaoPorCampanha([ad("c1", "s1", "ACTIVE"), ad("c1", "s2", "PENDING_REVIEW")]).c1!.semVeicular).toBe(false);
  });

  test("campanha pausada não é 'sem veicular' (o aviso é outro)", () => {
    const r = resolverVeiculacaoPorCampanha([ad("c1", "s1", "CAMPAIGN_PAUSED")]);
    expect(r.c1!.status).toBe("CAMPAIGN_PAUSED");
    expect(r.c1!.semVeicular).toBe(false);
  });

  test("sem adset_id não dá para contar conjuntos", () => {
    const r = resolverVeiculacaoPorCampanha([ad("c1", null, "ADSET_PAUSED")]);
    expect(r.c1!.conjuntos).toBeNull();
    expect(r.c1!.semVeicular).toBe(true);
  });

  test("ignora anúncio sem campanha, sem status ou com status desconhecido", () => {
    const r = resolverVeiculacaoPorCampanha([
      { adset_id: "s1", effective_status: "ACTIVE" },
      { campaign_id: "c1", adset_id: "s1" },
      ad("c2", "s2", "STATUS_NOVO_DA_META"),
      ad("c3", "s3", "ACTIVE"),
    ]);
    expect(Object.keys(r)).toEqual(["c3"]);
  });

  test("campanhas são independentes entre si", () => {
    const r = resolverVeiculacaoPorCampanha([
      ad("c1", "s1", "ADSET_PAUSED"),
      ad("c2", "s2", "ACTIVE"),
      ad("c2", "s3", "ADSET_PAUSED"),
    ]);
    expect(r.c1!.semVeicular).toBe(true);
    expect(r.c2!.semVeicular).toBe(false);
    expect(r.c2!.conjuntos).toEqual({ total: 2, ativos: 1, pausados: 1 });
  });

  test("lista vazia devolve objeto vazio", () => {
    expect(resolverVeiculacaoPorCampanha([])).toEqual({});
  });
});

describe("descreverConjuntosPausados", () => {
  test("singular quando há um conjunto só ou não se sabe quantos", () => {
    expect(descreverConjuntosPausados({ total: 1, ativos: 0, pausados: 1 })).toBe("O conjunto de anúncios está pausado");
    expect(descreverConjuntosPausados(null)).toBe("O conjunto de anúncios está pausado");
  });

  test("todos pausados", () => {
    expect(descreverConjuntosPausados({ total: 3, ativos: 0, pausados: 3 })).toBe("Todos os 3 conjuntos de anúncios estão pausados");
  });

  test("parte pausada, com concordância", () => {
    expect(descreverConjuntosPausados({ total: 3, ativos: 2, pausados: 1 })).toBe("1 de 3 conjuntos de anúncios está pausado");
    expect(descreverConjuntosPausados({ total: 4, ativos: 1, pausados: 3 })).toBe("3 de 4 conjuntos de anúncios estão pausados");
  });
});

describe("veiculacaoParcial", () => {
  test("só quando está ativa e há conjunto pausado", () => {
    expect(veiculacaoParcial({ status: "ACTIVE", conjuntos: { total: 2, ativos: 1, pausados: 1 } })).toBe(true);
    expect(veiculacaoParcial({ status: "ACTIVE", conjuntos: { total: 2, ativos: 2, pausados: 0 } })).toBe(false);
    expect(veiculacaoParcial({ status: "ADSET_PAUSED", conjuntos: { total: 1, ativos: 0, pausados: 1 } })).toBe(false);
    expect(veiculacaoParcial({ status: "ACTIVE", conjuntos: null })).toBe(false);
    expect(veiculacaoParcial(null)).toBe(false);
  });
});

describe("rotuloVeiculacao", () => {
  test("acrescenta a contagem só quando parte dos conjuntos está pausada", () => {
    const parcial = { status: "ACTIVE", conjuntos: { total: 3, ativos: 1, pausados: 2 } };
    expect(rotuloVeiculacao("Ativo", parcial)).toBe("Ativo · 2 de 3 conjuntos pausados");
    expect(rotuloVeiculacao("Ativo", { status: "ACTIVE", conjuntos: { total: 3, ativos: 3, pausados: 0 } })).toBe("Ativo");
    expect(rotuloVeiculacao("Conjunto pausado", { status: "ADSET_PAUSED", conjuntos: { total: 1, ativos: 0, pausados: 1 } })).toBe("Conjunto pausado");
  });

  test("sem rótulo ou sem dados devolve o que veio", () => {
    expect(rotuloVeiculacao(null, { status: "ACTIVE", conjuntos: { total: 2, ativos: 1, pausados: 1 } })).toBeNull();
    expect(rotuloVeiculacao("Ativo", null)).toBe("Ativo");
  });
});
