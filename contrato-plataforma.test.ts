import { expect, test } from "bun:test";
import { aplicarDescontoInicial, aplicarAjusteManual, manterAjusteAoRecalcular, montarItensCobrancaGestor, totalItens } from "./cobranca-gestor";
import {
  antesDoInicioDaCobranca,
  mesDoDescontoInicial,
  montarContrato,
  normalizarCondicoesContrato,
  previsaoMensalidade,
  telefoneContrato,
  type CondicoesContrato,
  type DadosContrato,
} from "./contrato-plataforma";

const base: CondicoesContrato = {
  forma: "diferenciado",
  valor_mensal: 300,
  desconto_tipo: "percentual",
  desconto_valor: 50,
  desconto_meses: 3,
  inicio_cobranca: "2026-11",
  dia_vencimento: 10,
  condicoes_extras: null,
};

const textoDe = (contrato: ReturnType<typeof montarContrato>, id: string) =>
  contrato.secoes.find((s) => s.id === id)!.paragrafos.join("\n");

test("respostas do Financeiro: obrigatórios por perfil e limites", () => {
  expect("erro" in normalizarCondicoesContrato({}, { gestor: false })).toBe(true);
  expect("erro" in normalizarCondicoesContrato({ forma: "normal", dia_vencimento: 10 }, { gestor: false })).toBe(true);
  expect("erro" in normalizarCondicoesContrato({ forma: "normal", valor_mensal: 100, dia_vencimento: 29 }, { gestor: false })).toBe(true);
  // desconto precisa do primeiro mês cobrado
  expect("erro" in normalizarCondicoesContrato(
    { forma: "normal", valor_mensal: 100, dia_vencimento: 5, desconto_tipo: "percentual", desconto_valor: 10, desconto_meses: 2 },
    { gestor: false }
  )).toBe(true);
  expect("erro" in normalizarCondicoesContrato(
    { forma: "normal", valor_mensal: 100, dia_vencimento: 5, desconto_tipo: "percentual", desconto_valor: 120, desconto_meses: 2, inicio_cobranca: "2026-11" },
    { gestor: false }
  )).toBe(true);

  const ok = normalizarCondicoesContrato(
    { forma: "diferenciado", valor_mensal: "1.234,50", dia_vencimento: "5", desconto_tipo: "valor", desconto_valor: "100", desconto_meses: "2", inicio_cobranca: "2026-11", condicoes_extras: "  sem fidelidade " },
    { gestor: false }
  );
  expect(ok).toEqual({
    condicoes: {
      forma: "diferenciado", valor_mensal: 1234.5, desconto_tipo: "valor", desconto_valor: 100, desconto_meses: 2,
      inicio_cobranca: "2026-11", dia_vencimento: 5, condicoes_extras: "sem fidelidade",
    },
  });

  // gestor: mensalidade e vencimento vêm da Cobrança dos Gestores; isento zera o desconto
  const gestor = normalizarCondicoesContrato({ forma: "normal", valor_mensal: 999, dia_vencimento: 3 }, { gestor: true });
  expect(gestor).toMatchObject({ condicoes: { valor_mensal: null, dia_vencimento: null } });
  const isento = normalizarCondicoesContrato({ forma: "isento", desconto_tipo: "percentual", desconto_valor: 10, desconto_meses: 2 }, { gestor: false });
  expect(isento).toMatchObject({ condicoes: { forma: "isento", desconto_tipo: "nenhum", desconto_valor: null, valor_mensal: null } });
});

test("desconto inicial conta os meses a partir do primeiro mês cobrado", () => {
  expect(mesDoDescontoInicial("2026-10", base)).toBeNull();
  expect(mesDoDescontoInicial("2026-11", base)).toBe(1);
  expect(mesDoDescontoInicial("2027-01", base)).toBe(3);
  expect(mesDoDescontoInicial("2027-02", base)).toBeNull();
  expect(mesDoDescontoInicial("2026-12", { ...base, desconto_tipo: "nenhum" })).toBeNull();
  expect(antesDoInicioDaCobranca("2026-10", base)).toBe(true);
  expect(antesDoInicioDaCobranca("2026-11", base)).toBe(false);
  expect(antesDoInicioDaCobranca("2020-01", { inicio_cobranca: null })).toBe(false);
});

test("previsão da mensalidade do usuário comum", () => {
  expect(previsaoMensalidade(base, "2026-10")).toMatchObject({ antes_do_inicio: true, total: 0 });
  expect(previsaoMensalidade(base, "2026-12")).toMatchObject({ base: 300, desconto: 150, total: 150, mes_desconto: 2 });
  expect(previsaoMensalidade(base, "2027-02")).toMatchObject({ desconto: 0, total: 300, mes_desconto: null });
  // desconto em R$ maior que a mensalidade não deixa o valor negativo
  expect(previsaoMensalidade({ ...base, desconto_tipo: "valor", desconto_valor: 500 }, "2026-11")).toMatchObject({ desconto: 300, total: 0 });
  expect(previsaoMensalidade({ ...base, forma: "isento" }, "2026-12")).toMatchObject({ isento: true, total: 0 });
  expect(previsaoMensalidade(null, "2026-12")).toBeNull();
});

test("fatura do gestor: desconto sobre mensalidade + clientes, VoIP fora, ajuste manual preservado", () => {
  const { itens } = montarItensCobrancaGestor({
    competencia: "2026-11",
    config: { mensalidade_brl: 200, valor_por_cliente_brl: 50, voip_margem_percentual: 0, voip_taxa_fixa_brl: 0 },
    clientes: [{ cliente_id: 1, nome: "Ana" }, { cliente_id: 2, nome: "Bruno" }],
    voip: [{ cliente_id: 1, nome: "Ana", linhas: 1, chamadas: 2, minutos: 3, numero_brl: 10, chamadas_brl: 5, custos_estimados: 0 }],
  });
  const comDesconto = aplicarDescontoInicial(itens, { tipo: "percentual", valor: 10, mes: 1, meses: 3 });
  expect(comDesconto.map((i) => i.tipo)).toEqual(["mensalidade", "clientes", "desconto", "voip"]);
  expect(comDesconto[2].valor_total).toBe(-30); // 10% de (200 + 2 × 50); os R$ 15 do VoIP ficam fora
  expect(totalItens(comDesconto)).toBe(285);

  // ajuste manual depois do desconto: o desconto continua e o ajuste fecha o novo total
  const ajustado = aplicarAjusteManual(comDesconto, 250);
  expect(ajustado.map((i) => i.tipo)).toEqual(["mensalidade", "clientes", "desconto", "voip", "ajuste"]);
  expect(totalItens(ajustado)).toBe(250);
  expect(manterAjusteAoRecalcular(comDesconto, ajustado).filter((i) => i.tipo === "desconto")).toHaveLength(1);

  // desconto em R$ não passa da base; sem base, nada muda
  expect(aplicarDescontoInicial(itens, { tipo: "valor", valor: 1000, mes: 1, meses: 1 })[2].valor_total).toBe(-300);
  const soVoip = itens.filter((i) => i.tipo === "voip");
  expect(aplicarDescontoInicial(soVoip, { tipo: "percentual", valor: 50, mes: 1, meses: 1 })).toEqual(soVoip);
});

const dadosUsuario = (extra: Partial<DadosContrato> = {}): DadosContrato => ({
  perfil: "usuario",
  contratante: { nome: "Ana Souza", email: "ana@x.com", telefone: "5511933842509", plano: "prata" },
  recursos: { whatsapp: true, voip: false },
  condicoes: base,
  pix: { chave: "contato@plataformadeleads.com.br", tipo_label: "E-mail" },
  ...extra,
});

test("contrato do usuário comum usa o cadastro e as condições do Financeiro", () => {
  const contrato = montarContrato(dadosUsuario());
  expect(contrato.pendencias).toEqual([]);
  expect(textoDe(contrato, "partes")).toContain("CONTRATANTE: Ana Souza, e-mail ana@x.com, telefone/WhatsApp (11) 93384-2509.");
  expect(textoDe(contrato, "objeto")).toContain("Plano contratado: Prata. Adicionais habilitados na conta: atendimento por WhatsApp.");
  const pagamento = textoDe(contrato, "pagamento");
  expect(pagamento).toContain("R$ 300,00 por mês, valor diferenciado negociado");
  expect(pagamento).toContain("nos 3 primeiros meses (de novembro de 2026 a janeiro de 2027), desconto de 50% sobre a mensalidade, que fica em R$ 150,00.");
  expect(pagamento).toContain("A cobrança começa em novembro de 2026.");
  expect(pagamento).toContain("todo dia 10");
  expect(pagamento).toContain("chave contato@plataformadeleads.com.br (E-mail)");
  expect(pagamento).toContain("não está incluído");
});

test("hash: muda com as condições, não com o telefone do cadastro", () => {
  const original = montarContrato(dadosUsuario());
  const outroTelefone = montarContrato(dadosUsuario({ contratante: { nome: "Ana Souza", email: "ana@x.com", telefone: "11999990000", plano: "prata" } }));
  const outroValor = montarContrato(dadosUsuario({ condicoes: { ...base, valor_mensal: 350 } }));
  expect(outroTelefone.hash).toBe(original.hash);
  expect(outroValor.hash).not.toBe(original.hash);
});

test("pendências: sem condições, sem WhatsApp, gestor sem valores, cliente sem valores do gestor", () => {
  expect(montarContrato(dadosUsuario({ condicoes: null })).pendencias).toHaveLength(1);
  expect(montarContrato(dadosUsuario({ contratante: { nome: "", email: "a@x.com", telefone: null, plano: "bronze" } })).pendencias)
    .toEqual(["Cadastre o seu WhatsApp em Configurações → Meu Perfil."]);

  const gestorSemValores = montarContrato(dadosUsuario({
    perfil: "gestor",
    condicoes: { ...base, forma: "normal", valor_mensal: null, dia_vencimento: null },
    gestor: { mensalidade_brl: 0, valor_por_cliente_brl: 0, dia_vencimento: 10 },
  }));
  expect(gestorSemValores.pendencias).toEqual(["A plataforma ainda não definiu os valores da sua cobrança."]);

  const cliente = montarContrato(dadosUsuario({
    perfil: "cliente_gerenciado",
    condicoes: null,
    gerenciado: {
      gestor_nome: "Peterson", gestor_email: "p@x.com", configurado: false, plano_nome: "Plano Gestão de Tráfego",
      valor_plano_mensal: 800, dia_vencimento: 10, adicionais: [], observacoes: null,
    },
  }));
  expect(cliente.pendencias).toEqual(["O gestor ainda não registrou os valores da sua conta no Financeiro."]);
  expect(textoDe(cliente, "pagamento")).not.toContain("800");
});

test("contrato do gestor: clientes gerenciados, VoIP sem expor margem e desconto fora do VoIP", () => {
  const contrato = montarContrato(dadosUsuario({
    perfil: "gestor",
    condicoes: { ...base, forma: "normal", valor_mensal: null, dia_vencimento: null },
    gestor: { mensalidade_brl: 200, valor_por_cliente_brl: 50, dia_vencimento: 12 },
  }));
  const pagamento = textoDe(contrato, "pagamento");
  expect(contrato.pendencias).toEqual([]);
  expect(pagamento).toContain("Mensalidade da plataforma: R$ 200,00 por mês.");
  expect(pagamento).toContain("R$ 50,00 por cliente, por mês");
  expect(pagamento).toContain("o VoIP não entra no desconto");
  expect(pagamento).toContain("vence no dia 12 do mês seguinte");
  expect(pagamento).not.toMatch(/margem/i);
  expect(textoDe(contrato, "objeto")).toContain("Clientes gerenciados");
  expect(textoDe(contrato, "contratante")).toContain("contas de clientes que criar");
});

test("contrato do cliente gerenciado: quem cobra é o gestor", () => {
  const contrato = montarContrato(dadosUsuario({
    perfil: "cliente_gerenciado",
    condicoes: null,
    recursos: { whatsapp: true, voip: true },
    gerenciado: {
      gestor_nome: "Peterson", gestor_email: "p@x.com", configurado: true, plano_nome: "Plano Gestão de Tráfego",
      valor_plano_mensal: 800, dia_vencimento: 5, adicionais: [{ descricao: "Uso do WhatsApp Business oficial", valor: 90 }],
      observacoes: "Primeiro mês grátis",
    },
  }));
  const pagamento = textoDe(contrato, "pagamento");
  expect(contrato.pendencias).toEqual([]);
  expect(pagamento).toContain("feita pelo gestor Peterson (p@x.com), e não pela CONTRATADA");
  expect(pagamento).toContain("Plano Gestão de Tráfego, R$ 800,00 por mês, com vencimento todo dia 5.");
  expect(pagamento).toContain("Uso do WhatsApp Business oficial: R$ 90,00 por mês.");
  expect(pagamento).toContain("VoIP é cobrada à parte");
  expect(pagamento).toContain("Primeiro mês grátis");
  expect(textoDe(contrato, "objeto")).toContain("administrada pelo gestor de tráfego Peterson");
});

test("telefone do cadastro formatado", () => {
  expect(telefoneContrato("5511933842509")).toBe("(11) 93384-2509");
  expect(telefoneContrato("1133334444")).toBe("(11) 3333-4444");
  expect(telefoneContrato("")).toBeNull();
});
