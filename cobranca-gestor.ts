// Fatura mensal que a plataforma cobra de cada gestor de tráfego (tipo trafego_pago).
//
// Não confundir com o "Financeiro" do card do cliente (cliente_financeiro_config), que é o
// que o GESTOR cobra do cliente dele. Aqui é o que o gestor paga para a plataforma:
//   - mensalidade própria;
//   - valor por cliente: todo cliente que esteve vinculado ao gestor em QUALQUER dia do mês
//     conta o mês inteiro (criar e desvincular antes do fechamento não escapa da cobrança);
//   - VoIP de cada cliente: custo real do provedor (número + minutos) + margem % + taxa fixa.
// A fatura de um mês (competência) é montada depois que o mês fecha e vence no mês seguinte.
// Este arquivo só calcula; quem lê o banco e grava é o index.ts.

import { custoRepasseBrl } from "./voip-custos";

export type ConfigCobrancaGestor = {
  mensalidade_brl: number;
  valor_por_cliente_brl: number;
  voip_margem_percentual: number;
  voip_taxa_fixa_brl: number;
};

export type ConfigCobrancaGestorParcial = {
  [K in keyof ConfigCobrancaGestor]?: number | string | null;
};

export type ClienteCobrado = {
  cliente_id: number;
  nome: string;
  email?: string | null;
};

export type VoipClienteMes = {
  cliente_id: number;
  nome: string;
  linhas: number;
  chamadas: number;
  minutos: number;
  numero_brl: number;
  chamadas_brl: number;
  custos_estimados: number;
};

export type TipoItemCobranca = "mensalidade" | "clientes" | "desconto" | "voip" | "ajuste";

export type ItemCobranca = {
  tipo: TipoItemCobranca;
  descricao: string;
  cliente_id: number | null;
  quantidade: number;
  valor_unitario: number;
  valor_total: number;
  // O gestor vê `detalhes`; `interno` (custo do provedor, margem) é só do super admin.
  detalhes: Record<string, unknown> | null;
  interno: Record<string, unknown> | null;
};

const CHAVES_CONFIG: (keyof ConfigCobrancaGestor)[] = [
  "mensalidade_brl",
  "valor_por_cliente_brl",
  "voip_margem_percentual",
  "voip_taxa_fixa_brl",
];

const MESES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

export function arredondarCentavos(valor: number) {
  return Math.round((Number(valor || 0) + Number.EPSILON) * 100) / 100;
}

function naoNegativo(valor: unknown) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Valor do gestor quando definido (inclusive 0); senão, o padrão da plataforma.
export function resolverConfigCobrancaGestor(
  padrao: ConfigCobrancaGestorParcial,
  especifica?: ConfigCobrancaGestorParcial | null
): ConfigCobrancaGestor {
  const resultado = {} as ConfigCobrancaGestor;
  for (const chave of CHAVES_CONFIG) {
    const proprio = especifica?.[chave];
    const usarProprio = proprio !== null && proprio !== undefined && proprio !== "";
    resultado[chave] = naoNegativo(usarProprio ? proprio : padrao?.[chave]);
  }
  return resultado;
}

export function competenciaValida(valor: unknown): valor is string {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(valor ?? ""));
}

export function competenciaAnterior(competencia: string) {
  const [ano, mes] = competencia.split("-").map(Number);
  return mes === 1 ? `${ano - 1}-12` : `${ano}-${String(mes - 1).padStart(2, "0")}`;
}

export function competenciaSeguinte(competencia: string) {
  const [ano, mes] = competencia.split("-").map(Number);
  return mes === 12 ? `${ano + 1}-01` : `${ano}-${String(mes + 1).padStart(2, "0")}`;
}

export function nomeCompetencia(competencia: string) {
  const [ano, mes] = competencia.split("-").map(Number);
  return `${MESES[mes - 1] || mes} de ${ano}`;
}

// Primeiro mês cobrado do gestor: o mais tardio entre o "Cobrar a partir de" da plataforma e
// o início do contrato dele (o que não for competência válida é ignorado). Vale para a
// geração automática, para os botões manuais e para a prévia.
export function inicioCobrancaGestor(...inicios: (string | null | undefined)[]): string | null {
  const validos = inicios.filter(competenciaValida).sort();
  return validos.length ? validos[validos.length - 1] : null;
}

// A fatura da competência vence no mês seguinte, no dia configurado (1 a 28).
export function vencimentoDaCompetencia(competencia: string, diaVencimento: unknown) {
  const dia = Math.min(Math.max(Math.trunc(Number(diaVencimento) || 10), 1), 28);
  return `${competenciaSeguinte(competencia)}-${String(dia).padStart(2, "0")}`;
}

export function totalItens(itens: Pick<ItemCobranca, "valor_total">[]) {
  return arredondarCentavos(itens.reduce((soma, item) => soma + Number(item.valor_total || 0), 0));
}

export function montarItensCobrancaGestor(params: {
  competencia: string;
  config: ConfigCobrancaGestor;
  clientes: ClienteCobrado[];
  voip: VoipClienteMes[];
}) {
  const { competencia, config } = params;
  const itens: ItemCobranca[] = [];

  if (config.mensalidade_brl > 0) {
    itens.push({
      tipo: "mensalidade",
      descricao: `Mensalidade da plataforma — ${nomeCompetencia(competencia)}`,
      cliente_id: null,
      quantidade: 1,
      valor_unitario: arredondarCentavos(config.mensalidade_brl),
      valor_total: arredondarCentavos(config.mensalidade_brl),
      detalhes: null,
      interno: null,
    });
  }

  // Um cliente desvinculado e vinculado de novo no mesmo mês conta uma vez só.
  const porId = new Map<number, ClienteCobrado>();
  for (const cliente of params.clientes || []) {
    const id = Number(cliente.cliente_id);
    if (Number.isInteger(id) && id > 0 && !porId.has(id)) porId.set(id, cliente);
  }
  const clientes = [...porId.values()].sort((a, b) =>
    String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR")
  );

  if (clientes.length && config.valor_por_cliente_brl > 0) {
    const unitario = arredondarCentavos(config.valor_por_cliente_brl);
    itens.push({
      tipo: "clientes",
      descricao: `Clientes gerenciados (${clientes.length})`,
      cliente_id: null,
      quantidade: clientes.length,
      valor_unitario: unitario,
      valor_total: arredondarCentavos(unitario * clientes.length),
      detalhes: {
        clientes: clientes.map((cliente) => ({
          cliente_id: Number(cliente.cliente_id),
          nome: cliente.nome || cliente.email || `Cliente ${cliente.cliente_id}`,
          email: cliente.email || null,
        })),
      },
      interno: null,
    });
  }

  for (const uso of params.voip || []) {
    const linhas = Number(uso.linhas || 0);
    const chamadas = Number(uso.chamadas || 0);
    if (linhas <= 0 && chamadas <= 0) continue;

    const custoProvedor = arredondarCentavos(Number(uso.numero_brl || 0) + Number(uso.chamadas_brl || 0));
    const valor = custoRepasseBrl(custoProvedor, config.voip_margem_percentual, config.voip_taxa_fixa_brl);
    if (valor <= 0) continue;

    itens.push({
      tipo: "voip",
      descricao: `VoIP — ${uso.nome || `Cliente ${uso.cliente_id}`}`,
      cliente_id: Number(uso.cliente_id),
      quantidade: 1,
      valor_unitario: valor,
      valor_total: valor,
      detalhes: {
        linhas,
        chamadas,
        minutos: Number(uso.minutos || 0),
        custos_estimados: Number(uso.custos_estimados || 0),
      },
      interno: {
        custo_provedor_brl: custoProvedor,
        numero_brl: arredondarCentavos(Number(uso.numero_brl || 0)),
        chamadas_brl: arredondarCentavos(Number(uso.chamadas_brl || 0)),
        margem_percentual: config.voip_margem_percentual,
        taxa_fixa_brl: config.voip_taxa_fixa_brl,
      },
    });
  }

  return { itens, total: totalItens(itens) };
}

// Quanto sai de desconto (em % ou R$) sobre uma base, nunca mais que a própria base.
export function valorDescontoSobre(base: number, tipo: string, valor: number | null | undefined) {
  const valorBase = Math.max(Number(base) || 0, 0);
  const bruto = tipo === "percentual"
    ? valorBase * Number(valor || 0) / 100
    : tipo === "valor" ? Number(valor || 0) : 0;
  return arredondarCentavos(Math.min(Math.max(bruto, 0), valorBase));
}

// Desconto inicial do contrato (contrato-plataforma.ts): incide sobre mensalidade + clientes
// e entra logo depois deles. O VoIP é custo repassado e fica fora. `mes` = qual mês do
// desconto é esta competência (1 = primeiro).
export function aplicarDescontoInicial(
  itens: ItemCobranca[],
  desconto: { tipo: "percentual" | "valor"; valor: number; mes: number; meses: number }
) {
  const base = arredondarCentavos(
    itens
      .filter((item) => item.tipo === "mensalidade" || item.tipo === "clientes")
      .reduce((soma, item) => soma + Number(item.valor_total || 0), 0)
  );
  const valor = valorDescontoSobre(base, desconto.tipo, desconto.valor);
  if (valor <= 0) return itens;

  const quanto = desconto.tipo === "percentual" ? ` · ${String(desconto.valor).replace(".", ",")}%` : "";
  const item: ItemCobranca = {
    tipo: "desconto",
    descricao: `Desconto inicial (mês ${desconto.mes} de ${desconto.meses}${quanto})`,
    cliente_id: null,
    quantidade: 1,
    valor_unitario: -valor,
    valor_total: -valor,
    detalhes: { mes: desconto.mes, meses: desconto.meses, tipo: desconto.tipo, valor: desconto.valor },
    interno: null,
  };
  const ultimaBase = itens.reduce(
    (posicao, atual, indice) => (atual.tipo === "mensalidade" || atual.tipo === "clientes" ? indice : posicao),
    -1
  );
  return [...itens.slice(0, ultimaBase + 1), item, ...itens.slice(ultimaBase + 1)];
}

// Ajuste feito pelo super admin (desconto ou acréscimo): vira um item "ajuste" com a
// diferença, para os itens continuarem somando o valor da fatura.
export function aplicarAjusteManual(itens: ItemCobranca[], novoTotal: number, descricao?: string | null) {
  const semAjuste = itens.filter((item) => item.tipo !== "ajuste");
  const diferenca = arredondarCentavos(Number(novoTotal) - totalItens(semAjuste));
  if (diferenca === 0) return semAjuste;
  return [
    ...semAjuste,
    {
      tipo: "ajuste" as const,
      descricao: String(descricao || "").trim() || (diferenca < 0 ? "Desconto" : "Acréscimo"),
      cliente_id: null,
      quantidade: 1,
      valor_unitario: diferenca,
      valor_total: diferenca,
      detalhes: null,
      interno: null,
    },
  ];
}

// Recalcular um rascunho mantém o ajuste que o super admin já tinha feito.
export function manterAjusteAoRecalcular(novos: ItemCobranca[], anteriores: ItemCobranca[]) {
  const ajuste = anteriores.find((item) => item.tipo === "ajuste");
  return ajuste ? [...novos.filter((item) => item.tipo !== "ajuste"), ajuste] : novos;
}

export function itensVisiveisAoGestor(itens: ItemCobranca[]) {
  return itens.map(({ interno: _interno, ...item }) => item);
}
