import { describe, expect, test } from "bun:test";
import {
  MINIMO_CONTAS_REDE,
  MINIMO_LEADS_REDE,
  NOTAS_BASE_MERCADO,
  PLATAFORMAS_RANKING,
  VARIACAO_MAXIMA_MERCADO,
  aplicarTravaVariacao,
  calcularNotasRede,
  combinarNotasMercado,
  extrairDiasDesempenho,
  extrairNotasMercado,
  normalizarSlugNicho,
  notasBaseDoNicho,
  type LinhaRedeBruta,
} from "./ranking-plataformas";

describe("normalizarSlugNicho", () => {
  test("mapeia os slugs do banco para as chaves da tabela de mercado", () => {
    expect(normalizarSlugNicho("saas")).toBe("plataforma");
    expect(normalizarSlugNicho("Planos de Saúde")).toBe("saude");
    expect(normalizarSlugNicho("cursos_online")).toBe("cursos_online");
    expect(normalizarSlugNicho("telecom")).toBe("telecom");
  });

  test("nicho desconhecido ou vazio cai em geral", () => {
    expect(normalizarSlugNicho("pet shop")).toBe("geral");
    expect(normalizarSlugNicho(null)).toBe("geral");
    expect(normalizarSlugNicho(undefined)).toBe("geral");
  });

  test("toda tabela base cobre as 8 plataformas", () => {
    for (const [nicho, notas] of Object.entries(NOTAS_BASE_MERCADO)) {
      for (const plataforma of PLATAFORMAS_RANKING) {
        expect(typeof notas[plataforma], `${nicho}.${plataforma}`).toBe("number");
      }
    }
    expect(notasBaseDoNicho("saas").linkedin).toBe(92);
  });
});

describe("aplicarTravaVariacao", () => {
  test("nota dentro da faixa passa sem alteração", () => {
    expect(aplicarTravaVariacao(85, 80)).toBe(85);
  });

  test("nota acima da faixa é cortada em +8", () => {
    expect(aplicarTravaVariacao(99, 80)).toBe(80 + VARIACAO_MAXIMA_MERCADO);
  });

  test("nota abaixo da faixa é cortada em -8", () => {
    expect(aplicarTravaVariacao(10, 80)).toBe(80 - VARIACAO_MAXIMA_MERCADO);
  });

  test("respeita os limites 0 e 100", () => {
    expect(aplicarTravaVariacao(150, 98)).toBe(100);
    expect(aplicarTravaVariacao(-20, 3)).toBe(0);
  });

  test("valor inválido não vira NaN", () => {
    expect(Number.isFinite(aplicarTravaVariacao(Number.NaN, 70))).toBe(true);
  });
});

describe("extrairNotasMercado", () => {
  test("descarta plataforma desconhecida, nota inválida e repetidas", () => {
    const notas = extrairNotasMercado({
      notas: [
        { plataforma: "Google", nota: 91.26, motivo: "  Busca   ativa  " },
        { plataforma: "google", nota: 10, motivo: "repetida" },
        { plataforma: "orkut", nota: 80, motivo: "não existe" },
        { plataforma: "meta", nota: "abc", motivo: "nota ruim" },
        { plataforma: "tiktok", nota: 130, motivo: "acima" },
        { plataforma: "linkedin", nota: -5, motivo: "abaixo" },
      ],
    });
    expect(notas.map((n) => n.plataforma)).toEqual(["google", "tiktok", "linkedin"]);
    expect(notas[0]!.motivo).toBe("Busca ativa");
    expect(notas[1]!.nota).toBe(100);
    expect(notas[2]!.nota).toBe(0);
  });

  test("resposta sem lista devolve vazio", () => {
    expect(extrairNotasMercado(null)).toEqual([]);
    expect(extrairNotasMercado({})).toEqual([]);
    expect(extrairNotasMercado({ notas: "x" })).toEqual([]);
  });
});

describe("combinarNotasMercado", () => {
  const base = notasBaseDoNicho("saas");
  const resposta = (plataformas: Array<[string, number]>) =>
    extrairNotasMercado({
      notas: plataformas.map(([plataforma, nota]) => ({ plataforma, nota, motivo: "m" })),
    });

  test("aplica a trava sobre a nota de partida na primeira vez", () => {
    const finais = combinarNotasMercado(
      resposta([["meta", 50], ["google", 95], ["tiktok", 20], ["linkedin", 88], ["kwai", 10]]),
      {},
      base
    );
    const porPlataforma = Object.fromEntries(finais.map((f) => [f.plataforma, f]));
    expect(porPlataforma.meta!.nota).toBe(base.meta - VARIACAO_MAXIMA_MERCADO);
    expect(porPlataforma.meta!.notaBruta).toBe(50);
    expect(porPlataforma.google!.nota).toBe(95);
    expect(porPlataforma.tiktok!.nota).toBe(base.tiktok - VARIACAO_MAXIMA_MERCADO);
  });

  test("usa a nota anterior salva, e não a de partida, quando existe", () => {
    const finais = combinarNotasMercado(
      resposta([["meta", 40], ["google", 60], ["tiktok", 80], ["linkedin", 20], ["kwai", 30]]),
      { meta: 45 },
      base
    );
    expect(finais.find((f) => f.plataforma === "meta")!.nota).toBe(40);
  });

  test("rejeita resposta com poucas plataformas", () => {
    expect(combinarNotasMercado(resposta([["meta", 80], ["google", 90]]), {}, base)).toEqual([]);
  });

  test("rejeita resposta em que todas as notas são praticamente iguais", () => {
    const igual = resposta(PLATAFORMAS_RANKING.map((p) => [p, 90] as [string, number]));
    expect(combinarNotasMercado(igual, {}, base)).toEqual([]);
  });
});

describe("calcularNotasRede", () => {
  const linha = (over: Partial<LinhaRedeBruta>): LinhaRedeBruta => ({
    nicho: "saas",
    plataforma: "google",
    contas: 5,
    leads: 100,
    qualificados: 40,
    fechados: 10,
    contas_gasto: 5,
    gasto: 2000,
    leads_gasto: 100,
    cliques: 3000,
    impressoes: 100000,
    ...over,
  });

  test("a plataforma com melhor custo e fechamento fica com a maior nota", () => {
    const rede = calcularNotasRede([
      linha({ plataforma: "google", gasto: 1500, fechados: 20, qualificados: 60 }),
      linha({ plataforma: "meta", gasto: 4000, fechados: 4, qualificados: 25 }),
    ]);
    expect(rede.saas!.google!.nota).toBeGreaterThan(rede.saas!.meta!.nota);
  });

  test("ignora plataforma sem amostra mínima de contas ou leads", () => {
    const rede = calcularNotasRede([
      linha({ plataforma: "google" }),
      linha({ plataforma: "meta" }),
      linha({ plataforma: "tiktok", contas: MINIMO_CONTAS_REDE - 1 }),
      linha({ plataforma: "linkedin", leads: MINIMO_LEADS_REDE - 1 }),
    ]);
    expect(Object.keys(rede.saas!).sort()).toEqual(["google", "meta"]);
  });

  test("nicho com uma única plataforma válida não entra", () => {
    const rede = calcularNotasRede([linha({ plataforma: "google" })]);
    expect(rede.saas).toBeUndefined();
  });

  test("sem gasto registrado calcula só com qualidade, volume e engajamento", () => {
    const rede = calcularNotasRede([
      linha({ plataforma: "google", contas_gasto: 0, gasto: 0, leads_gasto: 0 }),
      linha({ plataforma: "meta", contas_gasto: 0, gasto: 0, leads_gasto: 0, fechados: 2 }),
    ]);
    expect(rede.saas!.google!.nota).toBeGreaterThan(rede.saas!.meta!.nota);
    expect(rede.saas!.google!.nota).toBeLessThanOrEqual(100);
  });

  test("amostra maior dá peso maior à rede", () => {
    const pequena = calcularNotasRede([
      linha({ plataforma: "google", contas: 3, leads: 25 }),
      linha({ plataforma: "meta", contas: 3, leads: 25 }),
    ]);
    const grande = calcularNotasRede([
      linha({ plataforma: "google", contas: 12, leads: 400 }),
      linha({ plataforma: "meta", contas: 12, leads: 400 }),
    ]);
    expect(grande.saas!.google!.peso).toBeGreaterThan(pequena.saas!.google!.peso);
    expect(grande.saas!.google!.peso).toBeLessThanOrEqual(0.7);
  });

  test("não expõe dados de contas individuais, só agregados", () => {
    const rede = calcularNotasRede([linha({ plataforma: "google" }), linha({ plataforma: "meta" })]);
    expect(Object.keys(rede.saas!.google!).sort()).toEqual(["contas", "leads", "nota", "peso"]);
  });
});

describe("extrairDiasDesempenho", () => {
  test("mantém só dias com movimento e dados válidos", () => {
    const dias = extrairDiasDesempenho({
      dias: [
        { data: "2026-09-20", gasto: 12.345, cliques: 10.4, impressoes: 900 },
        { data: "2026-09-21", gasto: 0, cliques: 0, impressoes: 0 },
        { data: "21/09/2026", gasto: 5, cliques: 1, impressoes: 10 },
        { data: "2026-09-19", gasto: "x", cliques: 1, impressoes: 10 },
        { data: "2026-09-18", gasto: 0, cliques: 0, impressoes: 500 },
      ],
    });
    expect(dias).toEqual([
      { data: "2026-09-20", gasto: 12.35, cliques: 10, impressoes: 900 },
      { data: "2026-09-18", gasto: 0, cliques: 0, impressoes: 500 },
    ]);
  });

  test("resposta sem dias devolve vazio", () => {
    expect(extrairDiasDesempenho(null)).toEqual([]);
    expect(extrairDiasDesempenho({ error: "x" })).toEqual([]);
  });
});
