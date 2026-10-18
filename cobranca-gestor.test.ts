import { expect, test } from "bun:test";
import {
  aplicarAjusteManual,
  competenciaAnterior,
  itensVisiveisAoGestor,
  manterAjusteAoRecalcular,
  montarItensCobrancaGestor,
  nomeCompetencia,
  resolverConfigCobrancaGestor,
  totalItens,
  vencimentoDaCompetencia,
} from "./cobranca-gestor";

const padrao = { mensalidade_brl: 200, valor_por_cliente_brl: 50, voip_margem_percentual: 20, voip_taxa_fixa_brl: 5 };

test("valor do gestor substitui o padrão; vazio usa o padrão; 0 é valor de verdade", () => {
  expect(resolverConfigCobrancaGestor(padrao, null)).toEqual(padrao);
  expect(resolverConfigCobrancaGestor(padrao, { valor_por_cliente_brl: 40, mensalidade_brl: null })).toEqual({ ...padrao, valor_por_cliente_brl: 40 });
  expect(resolverConfigCobrancaGestor(padrao, { mensalidade_brl: 0 }).mensalidade_brl).toBe(0);
  expect(resolverConfigCobrancaGestor(padrao, { voip_margem_percentual: "" }).voip_margem_percentual).toBe(20);
  expect(resolverConfigCobrancaGestor({ mensalidade_brl: -5 }, null).mensalidade_brl).toBe(0);
});

test("competência: mês anterior, nome e vencimento no mês seguinte", () => {
  expect(competenciaAnterior("2026-01")).toBe("2025-12");
  expect(competenciaAnterior("2026-11")).toBe("2026-10");
  expect(nomeCompetencia("2026-10")).toBe("outubro de 2026");
  expect(vencimentoDaCompetencia("2026-10", 10)).toBe("2026-11-10");
  expect(vencimentoDaCompetencia("2026-12", 5)).toBe("2027-01-05");
  expect(vencimentoDaCompetencia("2026-02", 31)).toBe("2026-03-28");
});

test("fatura: mensalidade + clientes (cada um uma vez) + VoIP com margem", () => {
  const { itens, total } = montarItensCobrancaGestor({
    competencia: "2026-10",
    config: padrao,
    clientes: [
      { cliente_id: 7, nome: "Bruno" },
      { cliente_id: 3, nome: "Ana", email: "ana@x.com" },
      { cliente_id: 7, nome: "Bruno" }, // desvinculado e vinculado de novo no mês
    ],
    voip: [
      { cliente_id: 3, nome: "Ana", linhas: 1, chamadas: 12, minutos: 40.5, numero_brl: 22.14, chamadas_brl: 17.86, custos_estimados: 2 },
      { cliente_id: 7, nome: "Bruno", linhas: 0, chamadas: 0, minutos: 0, numero_brl: 0, chamadas_brl: 0, custos_estimados: 0 },
    ],
  });

  expect(itens.map((i) => i.tipo)).toEqual(["mensalidade", "clientes", "voip"]);
  expect(itens[1]).toMatchObject({ quantidade: 2, valor_unitario: 50, valor_total: 100 });
  expect((itens[1].detalhes as any).clientes.map((c: any) => c.nome)).toEqual(["Ana", "Bruno"]);
  // 40,00 de custo real × 1,20 + 5,00 de taxa fixa
  expect(itens[2]).toMatchObject({ cliente_id: 3, valor_total: 53, interno: { custo_provedor_brl: 40, margem_percentual: 20 } });
  expect(total).toBe(353);
  expect(totalItens(itens)).toBe(total);
});

test("sem valores configurados não gera item (fatura zerada não é emitida)", () => {
  const zerado = { mensalidade_brl: 0, valor_por_cliente_brl: 0, voip_margem_percentual: 0, voip_taxa_fixa_brl: 0 };
  const r = montarItensCobrancaGestor({ competencia: "2026-10", config: zerado, clientes: [{ cliente_id: 1, nome: "A" }], voip: [] });
  expect(r).toEqual({ itens: [], total: 0 });
});

test("VoIP sem margem repassa o custo real; sem uso no mês não entra", () => {
  const r = montarItensCobrancaGestor({
    competencia: "2026-10",
    config: { ...padrao, mensalidade_brl: 0, valor_por_cliente_brl: 0, voip_margem_percentual: 0, voip_taxa_fixa_brl: 0 },
    clientes: [],
    voip: [{ cliente_id: 9, nome: "C", linhas: 1, chamadas: 0, minutos: 0, numero_brl: 22.14, chamadas_brl: 0, custos_estimados: 0 }],
  });
  expect(r.itens).toHaveLength(1);
  expect(r.total).toBe(22.14);
});

test("ajuste manual vira item com a diferença e é mantido ao recalcular", () => {
  const base = montarItensCobrancaGestor({ competencia: "2026-10", config: padrao, clientes: [{ cliente_id: 1, nome: "A" }], voip: [] }).itens;
  const comDesconto = aplicarAjusteManual(base, 230);
  expect(comDesconto.at(-1)).toMatchObject({ tipo: "ajuste", descricao: "Desconto", valor_total: -20 });
  expect(totalItens(comDesconto)).toBe(230);
  expect(aplicarAjusteManual(comDesconto, 250).some((i) => i.tipo === "ajuste")).toBe(false);
  expect(aplicarAjusteManual(base, 260, "Implantação").at(-1)).toMatchObject({ descricao: "Implantação", valor_total: 10 });

  const recalculado = montarItensCobrancaGestor({ competencia: "2026-10", config: padrao, clientes: [{ cliente_id: 1, nome: "A" }, { cliente_id: 2, nome: "B" }], voip: [] }).itens;
  const mantido = manterAjusteAoRecalcular(recalculado, comDesconto);
  expect(totalItens(mantido)).toBe(280);
});

test("o gestor não vê custo do provedor nem margem", () => {
  const { itens } = montarItensCobrancaGestor({
    competencia: "2026-10",
    config: padrao,
    clientes: [],
    voip: [{ cliente_id: 3, nome: "Ana", linhas: 1, chamadas: 1, minutos: 1, numero_brl: 10, chamadas_brl: 1, custos_estimados: 0 }],
  });
  const visiveis = itensVisiveisAoGestor(itens);
  expect(JSON.stringify(visiveis)).not.toContain("custo_provedor");
  expect(JSON.stringify(visiveis)).not.toContain("margem");
  expect(visiveis[visiveis.length - 1].valor_total).toBe(itens[itens.length - 1].valor_total);
});
