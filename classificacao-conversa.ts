// Classificação da conversa de WhatsApp pela IA (ver
// classificarStatusLeadPorConversa no index.ts). Uma única chamada decide
// duas coisas:
// 1) o estágio do Kanban (já existia);
// 2) se o lead é QUALIFICADO pelos critérios do nicho — julgamento que entra
//    no score (score-lead.ts) e, portanto, no "Qualified Lead" que volta pras
//    plataformas de anúncio. Palavra-chave sozinha não entende "quero fechar
//    ainda este mês, tenho a entrada" escrito de outro jeito, nem percebe que
//    "qual o valor?" veio de alguém que depois disse que só estava vendo.

export type StatusKanbanIA = "novo" | "primeiro_contato" | "em_conversa" | "fechado" | "perdido";
export type ResultadoQualificacaoIA = "qualificado" | "nao_qualificado" | "indefinido";

export const STATUS_KANBAN_IA: StatusKanbanIA[] = ["novo", "primeiro_contato", "em_conversa", "fechado", "perdido"];

export function instrucoesQualificacao(nicho: string, qualificadores: string[]): string {
  const criterios = qualificadores.length ? qualificadores.join(", ") : "orçamento, prazo e necessidade concreta";
  return (
    `Além do estágio, avalie se o CLIENTE é um lead QUALIFICADO para ${nicho}. Julgue só pelo que o cliente escreveu — ` +
    `o que o corretor diz ou pergunta não conta como interesse do cliente. ` +
    `"qualificado": o cliente mostrou interesse real em comprar/contratar E deu pelo menos um dado concreto que o encaixa ` +
    `(critérios do nicho: ${criterios}; ou pediu proposta, visita, simulação, forma de pagamento). ` +
    `"nao_qualificado": deixou claro que não tem interesse, está só curioso sem intenção de comprar, está fora do perfil ` +
    `(sem orçamento, região não atendida, procura outra coisa), é número errado ou não quer ser contatado. ` +
    `"indefinido": informação insuficiente para julgar (conversa curta, só saudações, cliente ainda não respondeu). ` +
    `Use qualificacao_confianca:"alta" só quando a fala do cliente sustentar claramente o julgamento; na dúvida, "baixa".`
  );
}

export const SCHEMA_CLASSIFICACAO_CONVERSA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "confianca", "motivo", "qualificacao", "qualificacao_confianca", "qualificacao_motivo"],
  properties: {
    status: { type: "string", enum: STATUS_KANBAN_IA },
    confianca: { type: "string", enum: ["alta", "baixa"] },
    motivo: { type: "string" },
    qualificacao: { type: "string", enum: ["qualificado", "nao_qualificado", "indefinido"] },
    qualificacao_confianca: { type: "string", enum: ["alta", "baixa"] },
    qualificacao_motivo: { type: "string" }
  }
};

export const DESCRICAO_SCHEMA_CLASSIFICACAO_CONVERSA =
  `{"status":"novo"|"primeiro_contato"|"em_conversa"|"fechado"|"perdido","confianca":"alta"|"baixa","motivo":"string curta explicando o estágio",` +
  `"qualificacao":"qualificado"|"nao_qualificado"|"indefinido","qualificacao_confianca":"alta"|"baixa","qualificacao_motivo":"string curta com o que o cliente disse que justifica"}`;

export type ClassificacaoConversa = {
  status: StatusKanbanIA | null;
  motivo: string | null;
  qualificacao: { resultado: "qualificado" | "nao_qualificado"; motivo: string | null } | null;
};

function textoCurto(valor: unknown, limite = 240): string | null {
  const texto = String(valor ?? "").replace(/\s+/g, " ").trim();
  return texto ? texto.slice(0, limite) : null;
}

// Lê a resposta da IA. Tolera cerca de código e texto antes/depois do JSON
// (o fallback da Anthropic não tem formato estrito). Status e qualificação
// só valem com confiança "alta"; "indefinido" nunca vira sinal.
export function interpretarClassificacao(texto: string): ClassificacaoConversa {
  const semCerca = String(texto || "").replace(/```(?:json)?/gi, "");
  const inicio = semCerca.indexOf("{");
  const fim = semCerca.lastIndexOf("}");
  if (inicio < 0 || fim <= inicio) throw new Error("Resposta da IA sem JSON");
  const parsed: any = JSON.parse(semCerca.slice(inicio, fim + 1));

  const status =
    parsed?.confianca === "alta" && STATUS_KANBAN_IA.includes(parsed?.status) ? parsed.status : null;

  const resultado = parsed?.qualificacao;
  const qualificacao =
    parsed?.qualificacao_confianca === "alta" && (resultado === "qualificado" || resultado === "nao_qualificado")
      ? { resultado, motivo: textoCurto(parsed?.qualificacao_motivo) }
      : null;

  return { status, motivo: textoCurto(parsed?.motivo, 500), qualificacao };
}

// Valor salvo em leads.ia_qualificacao ({resultado, motivo, avaliado_em}).
export function lerQualificacaoIA(valor: unknown): { resultado: "qualificado" | "nao_qualificado"; motivo: string | null } | null {
  const bruto: any = typeof valor === "string" ? (() => { try { return JSON.parse(valor); } catch { return null; } })() : valor;
  const resultado = bruto?.resultado;
  if (resultado !== "qualificado" && resultado !== "nao_qualificado") return null;
  return { resultado, motivo: textoCurto(bruto?.motivo) };
}
