import { describe, expect, test } from "bun:test";
import {
  montarCampanhasDiaGoogle,
  normalizarNomeCampanha,
  type LinhaGoogleCampanhaDia,
} from "./performance-campanhas-dia";

const linha = (id: string, nome: string, custoMicros: number, cliques: number, impressoes: number): LinhaGoogleCampanhaDia => ({
  campaign: { id, name: nome },
  metrics: { costMicros: String(custoMicros), clicks: String(cliques), impressions: String(impressoes) },
});

const ids = (...lista: string[]) => new Set(lista);

describe("montarCampanhasDiaGoogle", () => {
  test("converte micros em reais, calcula o CPL e ordena por gasto", () => {
    const { campanhas } = montarCampanhasDiaGoogle(
      [
        linha("1", "Busca - Marca", 100_000_000, 50, 1000),
        linha("2", "Rede de Pesquisa", 250_500_000, 120, 4000),
      ],
      ids("1", "2"),
      [{ campanha: "Rede de Pesquisa", total: 5 }]
    );
    expect(campanhas.map((c) => c.nome)).toEqual(["Rede de Pesquisa", "Busca - Marca"]);
    expect(campanhas[0]).toEqual({
      campaign_id: "2",
      nome: "Rede de Pesquisa",
      gasto: 250.5,
      leads: 5,
      cliques: 120,
      impressoes: 4000,
      custo_por_lead: 50.1,
    });
    expect(campanhas[1]!.custo_por_lead).toBeNull();
    expect(campanhas[1]!.leads).toBe(0);
  });

  test("só entram campanhas criadas/importadas na plataforma", () => {
    const { campanhas } = montarCampanhasDiaGoogle(
      [linha("1", "Minha", 10_000_000, 5, 100), linha("9", "De fora", 90_000_000, 50, 900)],
      ids("1"),
      []
    );
    expect(campanhas.map((c) => c.campaign_id)).toEqual(["1"]);
  });

  test("soma linhas repetidas da mesma campanha", () => {
    const { campanhas } = montarCampanhasDiaGoogle(
      [linha("1", "A", 10_000_000, 5, 100), linha("1", "A", 5_000_000, 3, 50)],
      ids("1"),
      []
    );
    expect(campanhas).toHaveLength(1);
    expect(campanhas[0]).toMatchObject({ gasto: 15, cliques: 8, impressoes: 150 });
  });

  test("descarta campanha sem gasto, cliques nem impressões no dia", () => {
    const { campanhas } = montarCampanhasDiaGoogle(
      [linha("1", "Parada", 0, 0, 0), linha("2", "Só impressão", 0, 0, 40)],
      ids("1", "2"),
      []
    );
    expect(campanhas.map((c) => c.nome)).toEqual(["Só impressão"]);
  });

  test("casa os leads pelo nome ignorando maiúsculas, acentos e espaços a mais", () => {
    const { campanhas, leadsSemCampanha } = montarCampanhasDiaGoogle(
      [linha("1", "Campanha  Ação Verão", 40_000_000, 10, 200)],
      ids("1"),
      [{ campanha: "campanha ação verao ", total: "3" }]
    );
    expect(campanhas[0]!.leads).toBe(3);
    expect(campanhas[0]!.custo_por_lead).toBeCloseTo(13.3333, 3);
    expect(leadsSemCampanha).toBe(0);
  });

  test("leads que não casam com nenhuma campanha da lista viram 'sem campanha'", () => {
    const { campanhas, leadsSemCampanha } = montarCampanhasDiaGoogle(
      [linha("1", "A", 10_000_000, 5, 100)],
      ids("1"),
      [
        { campanha: "A", total: 2 },
        { campanha: "Outra sem gasto hoje", total: 4 },
        { campanha: null, total: 1 },
      ]
    );
    expect(campanhas[0]!.leads).toBe(2);
    expect(leadsSemCampanha).toBe(5);
  });

  test("duas campanhas com o mesmo nome não contam os mesmos leads duas vezes", () => {
    const { campanhas, leadsSemCampanha } = montarCampanhasDiaGoogle(
      [linha("1", "Mesmo Nome", 10_000_000, 5, 100), linha("2", "mesmo nome", 90_000_000, 40, 800)],
      ids("1", "2"),
      [{ campanha: "Mesmo Nome", total: 6 }]
    );
    expect(campanhas.map((c) => [c.campaign_id, c.leads])).toEqual([["2", 6], ["1", 0]]);
    expect(leadsSemCampanha).toBe(0);
  });

  test("valores estranhos da API não viram NaN", () => {
    const { campanhas } = montarCampanhasDiaGoogle(
      [{ campaign: { id: 1, name: null }, metrics: { costMicros: "x", clicks: null, impressions: undefined } }, linha("2", "Ok", 1_000_000, 1, 1)],
      ids("1", "2"),
      []
    );
    expect(campanhas.every((c) => Number.isFinite(c.gasto) && Number.isFinite(c.cliques))).toBe(true);
    expect(campanhas.map((c) => c.nome)).toEqual(["Ok"]);
  });

  test("sem dados devolve listas vazias", () => {
    expect(montarCampanhasDiaGoogle([], ids("1"), [])).toEqual({ campanhas: [], leadsSemCampanha: 0 });
  });
});

describe("normalizarNomeCampanha", () => {
  test("normaliza acento, caixa e espaços", () => {
    expect(normalizarNomeCampanha("  CP 02 — AÇÃO  [Diário] ")).toBe("cp 02 — acao [diario]");
    expect(normalizarNomeCampanha(null)).toBe("");
  });
});
