// Contrato de utilização da plataforma, montado com os dados que a plataforma já tem:
//   - contratante: nome, e-mail e WhatsApp do próprio cadastro;
//   - pagamento: as "condições do contrato" que o super admin responde em Financeiro dos
//     Usuários (contrato_condicoes) e, para o gestor de tráfego, os valores da Cobrança dos
//     Gestores; o cliente gerenciado paga ao gestor, nas condições do Financeiro do card dele.
// Este arquivo só valida, calcula e escreve o texto; quem lê o banco e grava é o index.ts.
// O hash cobre as cláusulas (não a identificação das partes): mudar valor, desconto ou o
// texto do modelo pede um novo aceite; trocar o telefone do cadastro não.

import { createHash } from "node:crypto";
import { arredondarCentavos, competenciaValida, nomeCompetencia, valorDescontoSobre } from "./cobranca-gestor";

// Mudou o texto das cláusulas? Suba a versão: todo mundo precisa aceitar de novo.
export const CONTRATO_VERSAO = "2026-10-18";

export const CONTRATADA = {
  razao_social: "55.848.095 MICHELE CRISTINE DOS SANTOS",
  cnpj: "55.848.095/0001-90",
  endereco: "Rua Serra do Mar, 490, Vila Princesa Isabel, São Paulo/SP, CEP 08410-160",
  email: "contato@plataformadeleads.com.br",
  telefone: "(11) 91007-9616",
  site: "plataformadeleads.com.br",
};

export type FormaCobranca = "normal" | "diferenciado" | "isento";
export type TipoDesconto = "nenhum" | "percentual" | "valor";
export type PerfilContrato = "usuario" | "gestor" | "cliente_gerenciado";

export type CondicoesContrato = {
  forma: FormaCobranca;
  valor_mensal: number | null;
  desconto_tipo: TipoDesconto;
  desconto_valor: number | null;
  desconto_meses: number | null;
  inicio_cobranca: string | null; // AAAA-MM: primeiro mês cobrado
  dia_vencimento: number | null;
  condicoes_extras: string | null;
};

const FORMAS: FormaCobranca[] = ["normal", "diferenciado", "isento"];
const TIPOS_DESCONTO: TipoDesconto[] = ["nenhum", "percentual", "valor"];
const VALOR_MAXIMO = 1000000;

function numeroOuNulo(valor: unknown) {
  if (valor === null || valor === undefined || String(valor).trim() === "") return null;
  const texto = String(valor).trim();
  const normalizado = typeof valor === "number"
    ? valor
    : Number(texto.includes(",") ? texto.replace(/\./g, "").replace(",", ".") : texto);
  return Number.isFinite(normalizado) ? Number(normalizado) : NaN;
}

// Respostas do formulário de Financeiro → condições gravadas. Gestor: mensalidade, valor por
// cliente e vencimento vêm da Cobrança dos Gestores, então valor_mensal e dia_vencimento
// ficam vazios aqui.
export function normalizarCondicoesContrato(
  body: any,
  opcoes: { gestor: boolean }
): { erro: string } | { condicoes: CondicoesContrato } {
  const forma = String(body?.forma || "") as FormaCobranca;
  if (!FORMAS.includes(forma)) {
    return { erro: "Escolha como este usuário é cobrado: valor normal, diferenciado ou isento." };
  }
  const isento = forma === "isento";

  let valorMensal: number | null = null;
  let diaVencimento: number | null = null;
  if (!opcoes.gestor && !isento) {
    valorMensal = numeroOuNulo(body?.valor_mensal);
    if (valorMensal === null || Number.isNaN(valorMensal) || valorMensal <= 0 || valorMensal > VALOR_MAXIMO) {
      return { erro: "Informe o valor da mensalidade (maior que zero)." };
    }
    valorMensal = arredondarCentavos(valorMensal);
    diaVencimento = Number(body?.dia_vencimento);
    if (!Number.isInteger(diaVencimento) || diaVencimento < 1 || diaVencimento > 28) {
      return { erro: "O dia de vencimento vai de 1 a 28." };
    }
  }

  const inicio = String(body?.inicio_cobranca || "").trim().slice(0, 7);
  if (inicio && !competenciaValida(inicio)) {
    return { erro: "Primeiro mês cobrado inválido (use AAAA-MM)." };
  }

  let descontoTipo = String(body?.desconto_tipo || "nenhum") as TipoDesconto;
  if (!TIPOS_DESCONTO.includes(descontoTipo)) return { erro: "Tipo de desconto inválido." };
  if (isento) descontoTipo = "nenhum";

  let descontoValor: number | null = null;
  let descontoMeses: number | null = null;
  if (descontoTipo !== "nenhum") {
    descontoValor = numeroOuNulo(body?.desconto_valor);
    const limite = descontoTipo === "percentual" ? 100 : VALOR_MAXIMO;
    if (descontoValor === null || Number.isNaN(descontoValor) || descontoValor <= 0 || descontoValor > limite) {
      return {
        erro: descontoTipo === "percentual"
          ? "Desconto em % vai de 0,01 a 100."
          : "Informe o valor do desconto em R$ (maior que zero).",
      };
    }
    descontoValor = arredondarCentavos(descontoValor);
    descontoMeses = Number(body?.desconto_meses);
    if (!Number.isInteger(descontoMeses) || descontoMeses < 1 || descontoMeses > 36) {
      return { erro: "O desconto inicial vale de 1 a 36 meses." };
    }
    if (!inicio) {
      return { erro: "Informe o primeiro mês cobrado: é dele que os meses de desconto são contados." };
    }
  }

  const extras = String(body?.condicoes_extras ?? "").trim().slice(0, 1000);

  return {
    condicoes: {
      forma,
      valor_mensal: valorMensal,
      desconto_tipo: descontoTipo,
      desconto_valor: descontoValor,
      desconto_meses: descontoMeses,
      inicio_cobranca: inicio || null,
      dia_vencimento: diaVencimento,
      condicoes_extras: extras || null,
    },
  };
}

function indiceMes(competencia: string) {
  const [ano, mes] = competencia.split("-").map(Number);
  return ano * 12 + (mes - 1);
}

function competenciaMaisMeses(competencia: string, meses: number) {
  const indice = indiceMes(competencia) + meses;
  return `${Math.floor(indice / 12)}-${String((indice % 12) + 1).padStart(2, "0")}`;
}

export function antesDoInicioDaCobranca(competencia: string, condicoes?: Pick<CondicoesContrato, "inicio_cobranca"> | null) {
  return Boolean(condicoes?.inicio_cobranca && competenciaValida(competencia) &&
    indiceMes(competencia) < indiceMes(condicoes.inicio_cobranca));
}

// Em que mês do desconto inicial cai a competência (1 = primeiro); null = sem desconto.
export function mesDoDescontoInicial(
  competencia: string,
  condicoes?: Pick<CondicoesContrato, "desconto_tipo" | "desconto_valor" | "desconto_meses" | "inicio_cobranca"> | null
) {
  if (!condicoes || condicoes.desconto_tipo === "nenhum") return null;
  if (!condicoes.inicio_cobranca || !competenciaValida(competencia)) return null;
  if (!(Number(condicoes.desconto_valor) > 0) || !(Number(condicoes.desconto_meses) > 0)) return null;
  const posicao = indiceMes(competencia) - indiceMes(condicoes.inicio_cobranca);
  return posicao >= 0 && posicao < Number(condicoes.desconto_meses) ? posicao + 1 : null;
}

// Quanto sai de desconto sobre a base (nunca mais que a base).
export function valorDoDesconto(base: number, condicoes: Pick<CondicoesContrato, "desconto_tipo" | "desconto_valor">) {
  return valorDescontoSobre(base, condicoes.desconto_tipo, condicoes.desconto_valor);
}

// Mensalidade prevista do usuário comum num mês (o mês do vencimento). Serve para sugerir o
// valor ao lançar a cobrança em Financeiro dos Usuários.
export function previsaoMensalidade(condicoes: CondicoesContrato | null, competencia: string) {
  if (!condicoes) return null;
  if (condicoes.forma === "isento") return { isento: true, antes_do_inicio: false, base: 0, desconto: 0, total: 0, mes_desconto: null };
  const base = Number(condicoes.valor_mensal || 0);
  if (antesDoInicioDaCobranca(competencia, condicoes)) {
    return { isento: false, antes_do_inicio: true, base, desconto: 0, total: 0, mes_desconto: null };
  }
  const mes = mesDoDescontoInicial(competencia, condicoes);
  const desconto = mes ? valorDoDesconto(base, condicoes) : 0;
  return { isento: false, antes_do_inicio: false, base, desconto, total: arredondarCentavos(base - desconto), mes_desconto: mes };
}

export type DadosContrato = {
  perfil: PerfilContrato;
  contratante: { nome: string; email: string; telefone: string | null; plano: string };
  recursos: { whatsapp: boolean; voip: boolean };
  condicoes: CondicoesContrato | null;
  pix?: { chave: string; tipo_label: string | null } | null;
  // Perfil gestor: valores efetivos da Cobrança dos Gestores (padrão ou próprios).
  gestor?: {
    mensalidade_brl: number;
    valor_por_cliente_brl: number;
    dia_vencimento: number;
  } | null;
  // Perfil cliente gerenciado: quem cobra é o gestor, nas condições do Financeiro do card.
  gerenciado?: {
    gestor_nome: string;
    gestor_email: string | null;
    configurado: boolean;
    plano_nome: string;
    valor_plano_mensal: number;
    dia_vencimento: number;
    adicionais: { descricao: string; valor: number }[];
    observacoes: string | null;
  } | null;
};

export type SecaoContrato = { id: string; titulo: string; paragrafos: string[] };

export type Contrato = {
  versao: string;
  titulo: string;
  hash: string;
  secoes: SecaoContrato[];
  pendencias: string[];
};

export function moedaContrato(valor: number) {
  return Number(valor || 0)
    .toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
    .replace(/\s+/g, " ");
}

function percentualContrato(valor: number) {
  return `${String(Number(valor || 0)).replace(".", ",")}%`;
}

export function telefoneContrato(valor: unknown) {
  let digitos = String(valor ?? "").replace(/\D/g, "");
  if (!digitos) return null;
  if ((digitos.length === 12 || digitos.length === 13) && digitos.startsWith("55")) digitos = digitos.slice(2);
  if (digitos.length === 11) return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7)}`;
  if (digitos.length === 10) return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 6)}-${digitos.slice(6)}`;
  return digitos;
}

const NOMES_PLANO: Record<string, string> = { bronze: "Bronze", prata: "Prata", ouro: "Ouro" };

function textoDescontoInicial(condicoes: CondicoesContrato, sobre: string, ficaEm?: string) {
  if (!condicoes.inicio_cobranca || !condicoes.desconto_meses || condicoes.desconto_tipo === "nenhum") return null;
  const meses = Number(condicoes.desconto_meses);
  const fim = competenciaMaisMeses(condicoes.inicio_cobranca, meses - 1);
  const periodo = meses === 1
    ? `no primeiro mês (${nomeCompetencia(condicoes.inicio_cobranca)})`
    : `nos ${meses} primeiros meses (de ${nomeCompetencia(condicoes.inicio_cobranca)} a ${nomeCompetencia(fim)})`;
  const quanto = condicoes.desconto_tipo === "percentual"
    ? percentualContrato(Number(condicoes.desconto_valor))
    : moedaContrato(Number(condicoes.desconto_valor));
  return `Desconto inicial: ${periodo}, desconto de ${quanto} sobre ${sobre}${ficaEm ? `, que fica em ${ficaEm}` : ""}. Depois desse período vale o valor cheio.`;
}

function paragrafosPagamento(dados: DadosContrato, pendencias: string[]) {
  const p: string[] = [];
  const condicoes = dados.condicoes;
  const pix = dados.pix?.chave
    ? `Pagamento por PIX na chave ${dados.pix.chave}${dados.pix.tipo_label ? ` (${dados.pix.tipo_label})` : ""}.`
    : "Pagamento por PIX, na chave indicada em cada cobrança.";
  const cortesia = "Cortesia: o uso da plataforma não é cobrado enquanto esta condição estiver em vigor. Se ela mudar, a CONTRATADA avisa com pelo menos 30 dias de antecedência e este contrato ganha uma nova versão para aceite.";

  if (dados.perfil === "cliente_gerenciado") {
    const g = dados.gerenciado;
    p.push(`A cobrança pelo uso desta conta é feita pelo gestor ${g?.gestor_nome || "responsável"}${g?.gestor_email ? ` (${g.gestor_email})` : ""}, e não pela CONTRATADA. O pagamento é combinado e feito diretamente com o gestor.`);
    if (g?.configurado) {
      p.push(`Condições informadas pelo gestor: ${g.plano_nome}, ${moedaContrato(g.valor_plano_mensal)} por mês, com vencimento todo dia ${g.dia_vencimento}.`);
      for (const adicional of g.adicionais) {
        p.push(`Adicional — ${adicional.descricao}: ${moedaContrato(adicional.valor)} por mês.`);
      }
      if (dados.recursos.voip) p.push("A telefonia VoIP é cobrada à parte, pelo uso (número e minutos de ligação) de cada mês.");
      if (g.observacoes) p.push(`Observações do gestor: ${g.observacoes}`);
    } else {
      p.push("O gestor ainda não registrou os valores desta conta.");
      pendencias.push("O gestor ainda não registrou os valores da sua conta no Financeiro.");
    }
    p.push("O valor investido nos anúncios (Meta, Google, TikTok) não está incluído e é pago diretamente às plataformas de anúncio.");
    return p;
  }

  if (!condicoes) {
    p.push("As condições de pagamento ainda não foram registradas pela CONTRATADA.");
    pendencias.push("A plataforma ainda não registrou as suas condições de pagamento.");
    return p;
  }

  if (dados.perfil === "gestor") {
    const g = dados.gestor || { mensalidade_brl: 0, valor_por_cliente_brl: 0, dia_vencimento: 10 };
    if (condicoes.forma === "isento") {
      p.push(cortesia);
    } else if (g.mensalidade_brl <= 0 && g.valor_por_cliente_brl <= 0) {
      p.push("Os valores da cobrança ainda não foram definidos pela CONTRATADA.");
      pendencias.push("A plataforma ainda não definiu os valores da sua cobrança.");
    } else {
      if (g.mensalidade_brl > 0) p.push(`Mensalidade da plataforma: ${moedaContrato(g.mensalidade_brl)} por mês.`);
      if (g.valor_por_cliente_brl > 0) {
        p.push(`Clientes gerenciados: ${moedaContrato(g.valor_por_cliente_brl)} por cliente, por mês. Todo cliente vinculado ao CONTRATANTE em qualquer dia do mês conta o mês inteiro, mesmo com a conta desativada; para deixar de pagar por um cliente, é preciso desvinculá-lo.`);
      }
      if (condicoes.forma === "diferenciado") p.push("Os valores acima são condições diferenciadas, negociadas com o CONTRATANTE.");
      const desconto = textoDescontoInicial(condicoes, "a mensalidade e os clientes gerenciados (o VoIP não entra no desconto)");
      if (desconto) p.push(desconto);
    }
    p.push("VoIP dos clientes: o uso de telefonia (número e minutos de ligação) de cada cliente no mês é cobrado conforme a tabela vigente da plataforma e aparece discriminado na fatura.");
    if (condicoes.inicio_cobranca) p.push(`A primeira fatura é a de ${nomeCompetencia(condicoes.inicio_cobranca)} (mês de uso).`);
    p.push(`A fatura de cada mês é fechada depois que o mês termina e vence no dia ${g.dia_vencimento} do mês seguinte, com o detalhe de cada item na tela Financeiro. ${pix} O comprovante é enviado pela tela Financeiro, onde também fica a nota fiscal.`);
  } else if (condicoes.forma === "isento") {
    p.push(cortesia);
  } else {
    const valor = Number(condicoes.valor_mensal || 0);
    p.push(condicoes.forma === "diferenciado"
      ? `Mensalidade: ${moedaContrato(valor)} por mês, valor diferenciado negociado com o CONTRATANTE.`
      : `Mensalidade: ${moedaContrato(valor)} por mês.`);
    const comDesconto = arredondarCentavos(valor - valorDoDesconto(valor, condicoes));
    const desconto = textoDescontoInicial(condicoes, "a mensalidade", moedaContrato(comDesconto));
    if (desconto) p.push(desconto);
    if (condicoes.inicio_cobranca) p.push(`A cobrança começa em ${nomeCompetencia(condicoes.inicio_cobranca)}.`);
    p.push(`Vencimento: todo dia ${condicoes.dia_vencimento} de cada mês. ${pix} O comprovante é enviado pela tela Financeiro, onde também fica a nota fiscal.`);
  }

  if (condicoes.forma !== "isento") {
    p.push("Em caso de atraso, a CONTRATADA envia lembretes pelo WhatsApp cadastrado e pode suspender o acesso até a regularização.");
  }
  p.push("Qualquer mudança de valor é avisada com pelo menos 30 dias de antecedência e gera uma nova versão deste contrato para aceite.");
  p.push(dados.perfil === "gestor"
    ? "O valor investido nos anúncios (Meta, Google, TikTok), do CONTRATANTE ou dos clientes dele, não está incluído e é pago diretamente às plataformas de anúncio."
    : "O valor investido nos anúncios (Meta, Google, TikTok) não está incluído e é pago pelo CONTRATANTE diretamente às plataformas de anúncio.");
  if (condicoes.condicoes_extras) p.push(`Condições adicionais combinadas: ${condicoes.condicoes_extras}`);
  return p;
}

export function montarContrato(dados: DadosContrato): Contrato {
  const pendencias: string[] = [];
  const telefone = telefoneContrato(dados.contratante.telefone);
  if (!telefone) pendencias.push("Cadastre o seu WhatsApp em Configurações → Meu Perfil.");

  const nome = String(dados.contratante.nome || "").trim() || dados.contratante.email;
  const plano = NOMES_PLANO[String(dados.contratante.plano || "").toLowerCase()] || "Bronze";
  const adicionais = [
    dados.recursos.whatsapp ? "atendimento por WhatsApp" : null,
    dados.recursos.voip ? "telefonia VoIP" : null,
  ].filter(Boolean);

  const objeto = [
    "Este contrato regula o uso, pelo CONTRATANTE, da Plataforma de Leads: sistema on-line para criar e acompanhar campanhas de anúncio (Meta, Google e TikTok), receber e organizar leads e fazer o atendimento comercial. O acesso é pessoal, não exclusivo e intransferível.",
    `Plano contratado: ${plano}.${adicionais.length ? ` Adicionais habilitados na conta: ${adicionais.join(" e ")}.` : ""}`,
  ];
  if (dados.perfil === "gestor") {
    objeto.push("Inclui o módulo Clientes gerenciados, para o CONTRATANTE criar e administrar dentro da plataforma as contas dos clientes dele.");
  }
  if (dados.perfil === "cliente_gerenciado") {
    const g = dados.gerenciado;
    objeto.push(`Esta conta é administrada pelo gestor de tráfego ${g?.gestor_nome || "responsável"}${g?.gestor_email ? ` (${g.gestor_email})` : ""}, que tem acesso a ela para operar as campanhas e o atendimento. As ações do gestor dentro da conta ficam registradas.`);
  }

  const responsabilidadesContratante = [
    "Manter os dados do cadastro corretos e a senha em sigilo. O que for feito com o seu acesso é de sua responsabilidade.",
    "Usar a plataforma de forma lícita e seguir as políticas da Meta, do Google, do TikTok e do WhatsApp, inclusive nos anúncios e nas mensagens enviadas aos leads.",
    "Tratar os dados dos leads conforme a Lei Geral de Proteção de Dados (LGPD): o CONTRATANTE é o controlador desses dados, e a plataforma os trata em nome dele.",
  ];
  if (dados.perfil === "gestor") {
    responsabilidadesContratante.push("Responder pelas contas de clientes que criar ou administrar: ter a autorização deles para operar as contas de anúncio e tratar os dados dos leads, e informá-los de que as ações do gestor dentro das contas ficam registradas.");
  }

  const secoes: SecaoContrato[] = [
    {
      id: "partes",
      titulo: "1. Partes",
      paragrafos: [
        `CONTRATADA: ${CONTRATADA.razao_social}, Microempreendedor Individual (MEI), CNPJ ${CONTRATADA.cnpj}, com endereço na ${CONTRATADA.endereco}, e-mail ${CONTRATADA.email}, operadora da Plataforma de Leads.`,
        `CONTRATANTE: ${nome}, e-mail ${dados.contratante.email}, telefone/WhatsApp ${telefone || "não informado"}.`,
      ],
    },
    { id: "objeto", titulo: "2. Objeto", paragrafos: objeto },
    { id: "pagamento", titulo: "3. Preço e pagamento", paragrafos: paragrafosPagamento(dados, pendencias) },
    { id: "contratante", titulo: "4. Responsabilidades do CONTRATANTE", paragrafos: responsabilidadesContratante },
    {
      id: "contratada",
      titulo: "5. Responsabilidades da CONTRATADA",
      paragrafos: [
        "Manter a plataforma funcionando com esforço razoável e avisar com antecedência as manutenções programadas, sempre que possível.",
        "Proteger os dados com conexão segura (HTTPS) e acesso restrito, e não vender nem compartilhar dados do CONTRATANTE ou dos leads com terceiros para fins de publicidade.",
        `Prestar suporte pelo chat da plataforma, pelo WhatsApp ${CONTRATADA.telefone} e pelo e-mail ${CONTRATADA.email}.`,
      ],
    },
    {
      id: "resultados",
      titulo: "6. Resultados",
      paragrafos: [
        "A plataforma é uma ferramenta: a CONTRATADA não garante quantidade de leads, vendas nem custo por lead, que dependem das campanhas, do mercado e das próprias plataformas de anúncio. Rankings, pontuações e sugestões da inteligência artificial são estimativas de apoio à decisão.",
        "Falhas ou mudanças nas APIs da Meta, do Google, do TikTok ou do WhatsApp podem afetar funções da plataforma sem que isso seja descumprimento deste contrato.",
      ],
    },
    {
      id: "privacidade",
      titulo: "7. Dados e privacidade",
      paragrafos: [
        `O tratamento de dados segue a Política de Privacidade (${CONTRATADA.site}/privacy-policy) e os Termos de Serviço (${CONTRATADA.site}/terms), que fazem parte deste contrato.`,
        "Os resultados das campanhas podem ser usados de forma agregada e anônima, sem identificar o CONTRATANTE, para compor o ranking de plataformas mostrado aos usuários.",
      ],
    },
    {
      id: "prazo",
      titulo: "8. Prazo e cancelamento",
      paragrafos: [
        "Este contrato vale por prazo indeterminado, a partir do aceite.",
        "Qualquer das partes pode cancelar a qualquer momento, sem multa, avisando pelo WhatsApp ou pelo e-mail cadastrados. Valores já pagos não são devolvidos, e o uso até a data do cancelamento continua devido.",
        "A CONTRATADA pode suspender ou encerrar o acesso em caso de uso ilegal, violação das políticas das plataformas de anúncio ou falta de pagamento.",
        `Depois do cancelamento, os dados podem ser excluídos a pedido, conforme as Instruções de Exclusão de Dados (${CONTRATADA.site}/data-deletion).`,
      ],
    },
    {
      id: "foro",
      titulo: "9. Foro",
      paragrafos: ["Fica eleito o foro da comarca de São Paulo/SP para resolver qualquer questão sobre este contrato."],
    },
    {
      id: "aceite",
      titulo: "10. Aceite eletrônico",
      paragrafos: [
        "Ao clicar em \"Li e aceito\", o CONTRATANTE concorda com este contrato. A plataforma registra a data, a hora, o IP e o texto aceito. Se as condições mudarem, uma nova versão é apresentada para aceite.",
      ],
    },
  ];

  const hash = createHash("sha256")
    .update(JSON.stringify({ versao: CONTRATO_VERSAO, secoes: secoes.filter((s) => s.id !== "partes") }))
    .digest("hex");

  return {
    versao: CONTRATO_VERSAO,
    titulo: "Contrato de utilização da Plataforma de Leads",
    hash,
    secoes,
    pendencias,
  };
}
