// Score automático do lead (frio/morno/quente). É ele que decide quando o
// evento "Qualified Lead" vai pra Meta/Google/TikTok/LinkedIn (ver
// avaliarEEnviarQualificacao* no index.ts) — ou seja, é o que ensina o
// algoritmo das plataformas a buscar mais gente parecida. Um "quente" falso
// não é só um número errado na tela: vira anúncio entregue pro público errado.
//
// Por isso o texto pontuado é só o que diz respeito ao LEAD:
// - fala do cliente no WhatsApp (whatsapp_transcricao_cliente, direcao
//   'entrada') — nunca a do corretor ('echo'): "vamos agendar uma visita?"
//   dito pelo corretor não é intenção do cliente;
// - respostas do formulário, interpretando sim/não contra a pergunta (a
//   pergunta sozinha é igual pra todo lead da campanha — "Precisa de
//   atendimento imediato?" não pode pontuar quem respondeu "não");
// - observação do corretor (é a avaliação dele sobre o cliente).
// O nome da campanha fica de fora: é o mesmo pra todos os leads dela
// ("Financiamento Casa Verde" daria intenção forte a todo mundo).
//
// A comparação é feita sem acento e por palavra inteira (com plural simples),
// respeitando negação ("não quero agendar", "sem entrada" não contam).

export type ChaveNicho =
  | "imoveis" | "saude" | "suplementos" | "saas" | "higienizacao" | "telecom"
  | "cursos_online" | "educacao" | "auto" | "consorcio";

// Chave curta de nicho usada tanto pelo contexto da IA (contextoNicho) quanto
// pela pontuação por regras e pelas features do ML (calcularScoreLead,
// extrairFeaturesMLLead) — único lugar que decide "qual nicho é esse lead".
export function detectarChaveNicho(lead: any): ChaveNicho | null {
  const slug = String(lead?.nicho_slug || "").toLowerCase();
  const nome = String(lead?.nicho_nome || "").toLowerCase();

  if (slug.includes("imovel") || slug.includes("imóvel") || nome.includes("imóv") || nome.includes("imovel")) return "imoveis";
  if (slug.includes("saude")  || slug.includes("saúde")  || nome.includes("saúde") || nome.includes("saude")) return "saude";
  if (slug.includes("suplement") || nome.includes("suplement")) return "suplementos";
  if (slug.includes("saas") || slug.includes("plataforma") || nome.includes("saas") || nome.includes("plataforma")) return "saas";
  if (slug.includes("higien") || nome.includes("higien")) return "higienizacao";
  if (slug.includes("telecom") || nome.includes("telecom")) return "telecom";
  if (slug.includes("curso_online") || slug.includes("cursos_online") || nome.includes("curso online") || nome.includes("cursos online")) return "cursos_online";
  if (slug.includes("educa") || nome.includes("educa") || nome.includes("curso") || nome.includes("ensino")) return "educacao";
  if (slug.includes("auto") || nome.includes("auto") || nome.includes("veículo") || nome.includes("veiculo") || nome.includes("carro")) return "auto";
  if (slug.includes("consorcio") || slug.includes("consórcio") || nome.includes("consórcio") || nome.includes("consorcio")) return "consorcio";

  return null;
}

// Termos sem acento: a comparação normaliza os dois lados.

// Próximo passo concreto de compra/contratação.
export const TERMOS_INTENCAO_FORTE = [
  "visita", "visitar", "agendar", "agendamento", "agendado", "agendada",
  "marcar horario", "marcar um horario",
  "simulacao", "simular", "financiamento", "financiar", "proposta",
  "contratar", "contratacao", "fechar negocio", "fechar o negocio", "fechar o plano",
  "fechar contrato", "quero fechar", "comprar", "compra", "adquirir", "assinar",
  "forma de pagamento", "link de pagamento", "pix", "boleto", "fazer o pedido", "fazer pedido"
];

// Perguntar preço é interesse, não decisão — pesa bem menos que intenção.
export const TERMOS_INTERESSE_PRECO = [
  "valor", "preco", "parcela", "orcamento", "mensalidade", "cotacao",
  "quanto custa", "quanto fica", "quanto sai"
];

// "hoje"/"rápido" soltos ficaram de fora: "hoje não posso", "uma pergunta
// rápida" não são urgência.
export const TERMOS_URGENCIA = [
  "urgente", "urgencia", "o quanto antes", "quanto antes", "mais rapido possivel",
  "mais breve possivel", "imediato", "imediata", "imediatamente", "hoje mesmo",
  "ainda hoje", "agora mesmo", "essa semana", "esta semana", "nessa semana",
  "nesta semana", "pra ja", "para ja", "preciso logo"
];

export const TERMOS_PREPARO_FINANCEIRO = [
  "renda", "credito", "fgts", "pre aprovado", "pre aprovada", "pre aprovacao",
  "a vista", "entrada", "dinheiro guardado", "tenho o valor"
];

export const TERMOS_BAIXO_INTERESSE = [
  "nao responde", "nao respondeu", "nao atende", "sem interesse", "nao tenho interesse",
  "perdi o interesse", "nao me interessa", "nao quero mais", "nao quero receber",
  "desistiu", "desisti", "so pesquisando", "apenas pesquisando", "so pesquisa",
  "so curiosidade", "por curiosidade", "so olhando", "numero errado", "foi engano",
  "nao solicitei", "nao pedi", "nao preenchi", "nao me cadastrei", "nao fiz cadastro",
  "pare de mandar", "parar de mandar", "nao mande mais", "nao me mande"
];

// Frases que só são desinteresse quando são a resposta inteira — "não quero"
// dentro de "não quero plano caro" é preferência, não recusa.
export const FRASES_RECUSA_INTEIRA = [
  "nao quero", "nao quero obrigado", "nao quero obrigada", "nao obrigado", "nao obrigada"
];

// Palavras-chave reais por nicho, usadas pela pontuação por regras
// (calcularScoreLead) — derivadas dos "qualificadores" que contextoNicho já
// usa nos prompts de IA. Só somam quando o termo não é um dos genéricos acima
// (senão "financiamento" contaria duas vezes em imóveis).
export const VOCABULARIO_NICHO: Record<ChaveNicho, string[]> = {
  imoveis: ["financiamento", "entrada", "visita", "aluguel", "condominio", "escritura", "metragem", "iptu", "chaves"],
  // cnpj/mei: plano empresarial (PME) é o que os formulários reais de saúde
  // qualificam ("Você possui CNPJ?").
  saude: ["cobertura", "sinistro", "carencia", "reembolso", "internacao", "operadora", "mensalidade", "dependente", "cnpj", "mei"],
  suplementos: ["assinatura", "recorrencia", "whey", "creatina", "treino", "academia", "hipertrofia", "emagrecimento", "dose"],
  saas: ["implantacao", "licenca", "usuarios", "integracao", "trial", "onboarding"],
  higienizacao: ["estofado", "colchao", "carpete", "tapete", "sofa", "acaro", "mofo", "pos obra", "agendamento", "orcamento"],
  telecom: ["internet dedicada", "link dedicado", "firewall", "pabx", "ramal", "hotspot", "wifi corporativo", "uptime", "sla", "provedor", "fornecedor"],
  cursos_online: ["curso online", "aula gravada", "aula ao vivo", "certificado", "acesso vitalicio", "plataforma de ensino", "parcelamento", "nova profissao", "renda extra", "inscricao", "modulo"],
  educacao: ["matricula", "turma", "bolsa", "certificado", "presencial", "carga horaria", "professor", "aula"],
  auto: ["seminovo", "revisao", "test drive", "quilometragem", "troca", "financiamento", "entrada", "placa", "laudo"],
  consorcio: ["carta de credito", "contemplacao", "lance", "grupo", "cota", "assembleia"]
};

const NEGADORES = new Set(["nao", "sem", "nunca", "nem", "jamais"]);

// A negação não atravessa conjunção: "não sei, mas quero visitar" conta.
const QUEBRAS_NEGACAO = new Set(["mas", "porem", "contudo", "entao", "e", "pois", "porque"]);

// "não" alcança o verbo mais adiante ("não sei se vou comprar"); "sem" só o
// que vem logo depois ("sem entrada" nega, "sem compromisso quero agendar" não).
const JANELA_NEGACAO = 5;
const JANELA_SEM = 2;

// Grafias de "não" comuns no WhatsApp.
const SINONIMOS_NAO = new Set(["n", "nn", "naum", "nao"]);

export function normalizarTextoScore(valor: unknown): string {
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

function tokenizar(trecho: string): string[] {
  const tokens = trecho.split(/[^a-z0-9]+/).filter(Boolean);
  // "n" seguido de número é "nº" de endereço, não "não".
  return tokens.map((token, i) =>
    SINONIMOS_NAO.has(token) && !(token === "n" && /^\d/.test(tokens[i + 1] || ""))
      ? "nao"
      : token
  );
}

// Pontuação separa orações: "Não. Quero visitar" não é "não quero visitar".
function clausulas(texto: string): string[][] {
  return normalizarTextoScore(texto)
    .split(/[.,;:!?\n\r()\[\]"]+/)
    .map(tokenizar)
    .filter(tokens => tokens.length > 0);
}

function tokenCasa(tokenTexto: string, tokenTermo: string, ultimo: boolean) {
  if (tokenTexto === tokenTermo) return true;
  // Plural simples só na última palavra do termo ("visitas", "parcelas").
  return ultimo && (tokenTexto === `${tokenTermo}s` || tokenTexto === `${tokenTermo}es`);
}

function negadoAntes(tokens: string[], inicio: number) {
  for (let i = inicio - 1; i >= 0 && i >= inicio - JANELA_NEGACAO; i--) {
    if (QUEBRAS_NEGACAO.has(tokens[i])) return false;
    if (tokens[i] === "sem") {
      if (inicio - i <= JANELA_SEM) return true;
      continue;
    }
    if (NEGADORES.has(tokens[i])) return true;
  }
  return false;
}

function termoNaClausula(tokens: string[], termo: string[]) {
  // Termo que já começa negando ("sem interesse", "não responde") não passa
  // pela checagem de negação — senão "não, não tenho interesse" se anularia.
  const checaNegacao = !NEGADORES.has(termo[0]);

  for (let i = 0; i + termo.length <= tokens.length; i++) {
    const casou = termo.every((t, j) => tokenCasa(tokens[i + j], t, j === termo.length - 1));
    if (casou && (!checaNegacao || !negadoAntes(tokens, i))) {
      return true;
    }
  }
  return false;
}

// Termos da lista presentes no texto (na ordem da lista, sem repetir).
export function encontrarTermos(texto: string, termos: string[]): string[] {
  const partes = clausulas(texto);
  if (!partes.length) return [];

  return termos.filter(termo => {
    const tokensTermo = tokenizar(normalizarTextoScore(termo));
    return tokensTermo.length > 0 && partes.some(tokens => termoNaClausula(tokens, tokensTermo));
  });
}

function recusaInteira(texto: string): string[] {
  const frases = new Set(FRASES_RECUSA_INTEIRA.map(f => tokenizar(f).join(" ")));
  return clausulas(texto)
    .map(tokens => tokens.join(" "))
    .filter(clausula => frases.has(clausula))
    .slice(0, 1);
}

const AFIRMATIVAS = new Set([
  "sim", "s", "ss", "yes", "claro", "quero", "tenho", "pretendo", "preciso",
  "positivo", "isso", "exato", "ok", "ja", "certeza", "com"
]);

// "sim" só tem sentido junto da pergunta; "não" anula a pergunta; resposta
// aberta vale pelo que o lead escreveu.
function respostaAfirmativa(resposta: string) {
  const tokens = clausulas(resposta).flat();
  if (!tokens.length || tokens.some(t => NEGADORES.has(t))) return false;
  if (tokens[0] === "com") return tokens[1] === "certeza";
  return AFIRMATIVAS.has(tokens[0]);
}

export function textoRespostasPontuaveis(respostas: unknown): string {
  if (!Array.isArray(respostas)) return "";

  return respostas
    .map((item: any) => {
      const pergunta = String(item?.pergunta ?? "");
      const resposta = String(item?.resposta ?? "");
      if (!resposta.trim()) return "";
      return respostaAfirmativa(resposta) ? `${pergunta}. ${resposta}` : resposta;
    })
    .filter(Boolean)
    .join(". ");
}

// Tudo que é sinal do lead (e só do lead). Usado pelo score e pelos sinais
// exibidos na análise da IA.
export function textoSinaisDoLead(lead: any): string {
  return [
    lead?.observacao,
    textoRespostasPontuaveis(lead?.respostas_qualificacao),
    lead?.whatsapp_transcricao_cliente
  ]
    .filter(Boolean)
    .join(". ");
}

function listarTermos(termos: string[]) {
  return termos.slice(0, 3).map(t => `"${t}"`).join(", ");
}

export const PONTOS_SCORE_QUENTE = 70;
export const PONTOS_SCORE_MORNO = 35;

// 🔥 SCORE AUTOMÁTICO
export function calcularScoreLead(lead: any) {

  // 🔥 SCORE MANUAL
  if (lead?.score_manual) {
    return {
      score: lead.score_manual,
      pontos: null,
      base: ["Score definido manualmente"]
    };
  }

  let pontos = 0;
  const base: string[] = [];
  const texto = textoSinaisDoLead(lead);

  // 🆕 Lead novo
  pontos += 10;
  base.push("+10 Lead recém capturado");

  if (lead?.telefone) {
    pontos += 10;
    base.push("+10 Telefone informado");
  }

  if (lead?.email) {
    pontos += 5;
    base.push("+5 Email informado");
  }

  if (lead?.status === "primeiro_contato") {
    pontos += 15;
    base.push("+15 Atendimento iniciado");
  }

  if (lead?.status === "em_conversa") {
    pontos += 30;
    base.push("+30 Lead em conversa");
  }

  if (lead?.status === "fechado") {
    pontos += 60;
    base.push("+60 Lead fechado");
  }

  if (lead?.status === "perdido") {
    pontos -= 40;
    base.push("-40 Lead marcado como perdido");
  }

  const intencao = encontrarTermos(texto, TERMOS_INTENCAO_FORTE);
  if (intencao.length) {
    pontos += 30;
    base.push(`+30 Intenção forte do lead: ${listarTermos(intencao)}`);
  }

  const preco = encontrarTermos(texto, TERMOS_INTERESSE_PRECO);
  if (preco.length) {
    pontos += 10;
    base.push(`+10 Lead perguntou sobre preço/condições: ${listarTermos(preco)}`);
  }

  const urgencia = encontrarTermos(texto, TERMOS_URGENCIA);
  if (urgencia.length) {
    pontos += 20;
    base.push(`+20 Lead demonstra urgência: ${listarTermos(urgencia)}`);
  }

  const preparo = encontrarTermos(texto, TERMOS_PREPARO_FINANCEIRO);
  if (preparo.length) {
    pontos += 15;
    base.push(`+15 Lead indica preparo financeiro: ${listarTermos(preparo)}`);
  }

  const desinteresse = [
    ...encontrarTermos(texto, TERMOS_BAIXO_INTERESSE),
    ...recusaInteira(texto)
  ];
  if (desinteresse.length) {
    pontos -= 30;
    base.push(`-30 Lead indica baixo interesse: ${listarTermos(desinteresse)}`);
  }

  // 🔄 Lead repetido
  if (lead?.repetido) {
    pontos += 20;
    base.push("+20 Lead retornou novamente");
  }

  // 🎯 Sinal específico do nicho do lead (imóveis, saúde, suplementos...) —
  // além das regras genéricas acima, cada nicho tem seu próprio vocabulário
  // de intenção forte (ver VOCABULARIO_NICHO).
  const chaveNicho = detectarChaveNicho(lead);

  if (chaveNicho) {
    const genericos = new Set([
      ...TERMOS_INTENCAO_FORTE, ...TERMOS_INTERESSE_PRECO, ...TERMOS_URGENCIA, ...TERMOS_PREPARO_FINANCEIRO
    ]);
    const doNicho = encontrarTermos(
      texto,
      VOCABULARIO_NICHO[chaveNicho].filter(termo => !genericos.has(termo))
    );

    if (doNicho.length) {
      pontos += 20;
      base.push(`+20 Sinal específico do nicho (${lead?.nicho_nome || chaveNicho}): ${listarTermos(doNicho)}`);
    }
  }

  // 🔥 Classificação final
  let score = "frio";

  if (pontos >= PONTOS_SCORE_QUENTE) {
    score = "quente";
  } else if (pontos >= PONTOS_SCORE_MORNO) {
    score = "morno";
  }

  return { score, pontos, base };
}
