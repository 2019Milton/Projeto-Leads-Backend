import { expect, test } from "bun:test";
import { calcularScoreLead, encontrarTermos, textoRespostasPontuaveis, TERMOS_INTENCAO_FORTE, TERMOS_BAIXO_INTERESSE } from "./score-lead";

const base = { telefone: "5511999999999", email: "a@b.com", status: "em_conversa" }; // 55 pontos
const temLinha = (r: any, inicio: string) => r.base.some((l: string) => l.startsWith(inicio));

test("nome da campanha não pontua (é igual pra todos os leads dela)", () => {
  const r = calcularScoreLead({ ...base, campanha: "Financiamento - agende sua visita hoje, valor de entrada urgente" });
  expect(r.pontos).toBe(55);
  expect(r.score).toBe("morno");
});

test("só a fala do cliente conta, nunca a do corretor", () => {
  const corretor = calcularScoreLead({ ...base, whatsapp_transcricao: "Corretor: vamos agendar uma visita? Posso simular o financiamento" });
  expect(corretor.pontos).toBe(55);

  const cliente = calcularScoreLead({ ...base, whatsapp_transcricao_cliente: "quero agendar uma visita" });
  expect(cliente.pontos).toBe(85);
  expect(cliente.score).toBe("quente");
  expect(cliente.base).toContain('+30 Intenção forte do lead: "visita", "agendar"');
});

test("acentos e caixa não impedem o casamento dos termos", () => {
  expect(encontrarTermos("Pode fazer uma SIMULAÇÃO?", TERMOS_INTENCAO_FORTE)).toEqual(["simulacao"]);
  expect(temLinha(calcularScoreLead({ whatsapp_transcricao_cliente: "me manda um orçamento" }), "+10 Lead perguntou sobre preço")).toBe(true);
  expect(temLinha(calcularScoreLead({ whatsapp_transcricao_cliente: "já tenho crédito pré-aprovado" }), "+15 Lead indica preparo financeiro")).toBe(true);
  expect(temLinha(calcularScoreLead({ observacao: "Cliente não responde" }), "-30")).toBe(true);
  expect(temLinha(calcularScoreLead({ whatsapp_transcricao_cliente: "é urgente, preciso rápido" }), "+20 Lead demonstra urgência")).toBe(true);
});

test("casa palavra inteira (com plural), não pedaço de palavra", () => {
  expect(encontrarTermos("o bairro vai valorizar muito", ["valor"])).toEqual([]);
  expect(encontrarTermos("quais os valores das parcelas?", ["valor", "parcela"])).toEqual(["valor", "parcela"]);
  expect(encontrarTermos("posso marcar visitas no sábado", TERMOS_INTENCAO_FORTE)).toEqual(["visita"]);
  expect(encontrarTermos("recompra de pontos", TERMOS_INTENCAO_FORTE)).toEqual([]);
});

test("'hoje' e 'rápido' soltos não são urgência", () => {
  const r = calcularScoreLead({ whatsapp_transcricao_cliente: "hoje não posso falar, uma pergunta rápida" });
  expect(temLinha(r, "+20 Lead demonstra urgência")).toBe(false);
});

test("negação anula o termo; conjunção e pontuação encerram a negação", () => {
  expect(encontrarTermos("não quero agendar nada", TERMOS_INTENCAO_FORTE)).toEqual([]);
  expect(encontrarTermos("não sei se vou comprar", TERMOS_INTENCAO_FORTE)).toEqual([]);
  expect(encontrarTermos("n quero visitar", TERMOS_INTENCAO_FORTE)).toEqual([]);
  expect(encontrarTermos("não tenho entrada", ["entrada"])).toEqual([]);
  expect(encontrarTermos("estou sem entrada", ["entrada"])).toEqual([]);
  expect(encontrarTermos("não sei, mas quero visitar", TERMOS_INTENCAO_FORTE)).toEqual(["visitar"]);
  expect(encontrarTermos("não sei ainda mas quero visitar", TERMOS_INTENCAO_FORTE)).toEqual(["visitar"]);
  expect(encontrarTermos("Não. Quero visitar amanhã", TERMOS_INTENCAO_FORTE)).toEqual(["visitar"]);
  expect(encontrarTermos("sem compromisso quero agendar", TERMOS_INTENCAO_FORTE)).toEqual(["agendar"]);
  expect(encontrarTermos("fica na rua 7, n 50, quero visitar", TERMOS_INTENCAO_FORTE)).toEqual(["visitar"]);
  expect(encontrarTermos("apto n 50 quero visitar", TERMOS_INTENCAO_FORTE)).toEqual(["visitar"]);
});

test("desinteresse: frases negativas contam mesmo depois de outro 'não'", () => {
  expect(encontrarTermos("não, não tenho interesse", TERMOS_BAIXO_INTERESSE)).toEqual(["nao tenho interesse"]);
  expect(encontrarTermos("não estou só pesquisando", TERMOS_BAIXO_INTERESSE)).toEqual([]);
  expect(temLinha(calcularScoreLead({ whatsapp_transcricao_cliente: "Não quero." }), "-30")).toBe(true);
  expect(temLinha(calcularScoreLead({ whatsapp_transcricao_cliente: "não quero plano caro" }), "-30")).toBe(false);
});

test("resposta sim/não é lida contra a pergunta", () => {
  const pergunta = "Precisa de atendimento médico imediato?";
  const sim = calcularScoreLead({ respostas_qualificacao: [{ pergunta, resposta: "Sim" }] });
  const nao = calcularScoreLead({ respostas_qualificacao: [{ pergunta, resposta: "não" }] });
  expect(temLinha(sim, "+20 Lead demonstra urgência")).toBe(true);
  expect(nao.pontos).toBe(10);

  // A pergunta cita "valor", mas a resposta aberta é o que o lead disse.
  const aberta = calcularScoreLead({ respostas_qualificacao: [{ pergunta: "Qual valor pretende investir?", resposta: "uns 300 mil" }] });
  expect(aberta.pontos).toBe(10);

  expect(textoRespostasPontuaveis([{ pergunta: "Pretende financiar?", resposta: "com certeza" }])).toContain("Pretende financiar?");
  expect(textoRespostasPontuaveis([{ pergunta: "Pretende financiar?", resposta: "sim, mas não agora" }])).not.toContain("Pretende");
  expect(textoRespostasPontuaveis("lixo")).toBe("");
});

test("termo do nicho só soma quando não é um termo genérico já contado", () => {
  const imoveis = { nicho_slug: "imoveis", nicho_nome: "Imóveis" };
  const financiamento = calcularScoreLead({ ...imoveis, whatsapp_transcricao_cliente: "é por financiamento" });
  expect(temLinha(financiamento, "+20 Sinal específico do nicho")).toBe(false);
  expect(financiamento.pontos).toBe(40);

  const condominio = calcularScoreLead({ ...imoveis, whatsapp_transcricao_cliente: "qual o condomínio?" });
  expect(condominio.base).toContain('+20 Sinal específico do nicho (Imóveis): "condominio"');

  const saude = calcularScoreLead({ nicho_slug: "saude", nicho_nome: "Planos de Saúde", respostas_qualificacao: [{ pergunta: "Voce possui CNPJ?", resposta: "sim" }] });
  expect(temLinha(saude, "+20 Sinal específico do nicho")).toBe(true);
});

test("reconhece Faculdade/Universidade e Dentista como nichos próprios", () => {
  const faculdade = calcularScoreLead({
    nicho_slug: "faculdade_universidade",
    nicho_nome: "Faculdade / Universidade",
    whatsapp_transcricao_cliente: "quero saber sobre bolsa e matrícula"
  });
  expect(faculdade.base.some((l: string) => l.includes("Faculdade / Universidade"))).toBe(true);

  const dentista = calcularScoreLead({
    nicho_slug: "dentista",
    nicho_nome: "Dentista",
    whatsapp_transcricao_cliente: "quero fazer uma avaliação para implante"
  });
  expect(dentista.base.some((l: string) => l.includes("Dentista"))).toBe(true);
});

test("faixas, status e score manual", () => {
  expect(calcularScoreLead({}).score).toBe("frio");
  expect(calcularScoreLead({ ...base, whatsapp_transcricao_cliente: "qual o valor?" }).score).toBe("morno");
  expect(calcularScoreLead({ telefone: "1", status: "fechado" }).score).toBe("quente");
  expect(calcularScoreLead({ ...base, status: "perdido" }).score).toBe("frio");
  expect(calcularScoreLead({ ...base, repetido: true, whatsapp_transcricao_cliente: "qual o valor?" }).score).toBe("quente");
  expect(calcularScoreLead({ score_manual: "quente" })).toEqual({ score: "quente", pontos: null, base: ["Score definido manualmente"] });
});
