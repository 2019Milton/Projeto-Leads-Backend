import { expect, test } from "bun:test";
import { instrucoesQualificacao, interpretarClassificacao, lerQualificacaoIA, SCHEMA_CLASSIFICACAO_CONVERSA } from "./classificacao-conversa";
import { calcularScoreLead } from "./score-lead";

const resposta = (extra: object) => JSON.stringify({
  status: "em_conversa", confianca: "alta", motivo: "negociando",
  qualificacao: "qualificado", qualificacao_confianca: "alta", qualificacao_motivo: "tem a entrada e quer fechar este mês",
  ...extra
});

test("lê status e qualificação só com confiança alta", () => {
  expect(interpretarClassificacao(resposta({}))).toEqual({
    status: "em_conversa",
    motivo: "negociando",
    qualificacao: { resultado: "qualificado", motivo: "tem a entrada e quer fechar este mês" }
  });
  expect(interpretarClassificacao(resposta({ confianca: "baixa" })).status).toBeNull();
  expect(interpretarClassificacao(resposta({ qualificacao_confianca: "baixa" })).qualificacao).toBeNull();
  expect(interpretarClassificacao(resposta({ qualificacao: "indefinido" })).qualificacao).toBeNull();
  expect(interpretarClassificacao(resposta({ qualificacao: "nao_qualificado", qualificacao_motivo: "só curiosidade" })).qualificacao)
    .toEqual({ resultado: "nao_qualificado", motivo: "só curiosidade" });
  expect(interpretarClassificacao(resposta({ status: "inventado" })).status).toBeNull();
});

test("tolera cerca de código e texto em volta do JSON (fallback sem formato estrito)", () => {
  expect(interpretarClassificacao("```json\n" + resposta({}) + "\n```").status).toBe("em_conversa");
  expect(interpretarClassificacao("Segue a análise: " + resposta({}) + " Obrigado.").qualificacao?.resultado).toBe("qualificado");
  expect(() => interpretarClassificacao("não sei")).toThrow();
});

test("resposta antiga (sem campos de qualificação) continua funcionando", () => {
  const antiga = interpretarClassificacao(JSON.stringify({ status: "perdido", confianca: "alta", motivo: "desistiu" }));
  expect(antiga).toEqual({ status: "perdido", motivo: "desistiu", qualificacao: null });
});

test("instrução usa os critérios do nicho e o formato exige os campos novos", () => {
  const texto = instrucoesQualificacao("Imóveis", ["faixa de valor", "prazo para decisão"]);
  expect(texto).toContain("Imóveis");
  expect(texto).toContain("faixa de valor, prazo para decisão");
  expect(texto).toContain("o que o corretor diz ou pergunta não conta");
  expect(texto).toContain("Não presuma");
  expect(texto).toContain("NÃO bastam");
  expect(SCHEMA_CLASSIFICACAO_CONVERSA.required).toContain("qualificacao");
});

test("julgamento da IA entra no score: qualifica sem palavra-chave e derruba falso positivo", () => {
  const base = { telefone: "1", status: "em_conversa" }; // 50 pontos
  const semPalavra = calcularScoreLead({ ...base, whatsapp_transcricao_cliente: "pode ser no mês que vem, já tenho metade guardada",
    ia_qualificacao: { resultado: "qualificado", motivo: "tem parte do valor guardada", avaliado_em: "2026-09-29" } });
  expect(semPalavra.pontos).toBe(80);
  expect(semPalavra.score).toBe("quente");
  expect(semPalavra.base).toContain("+30 IA avaliou a conversa: lead qualificado: tem parte do valor guardada");

  const falsoPositivo = calcularScoreLead({ ...base, whatsapp_transcricao_cliente: "quero agendar uma visita",
    ia_qualificacao: JSON.stringify({ resultado: "nao_qualificado", motivo: "depois disse que só estava vendo" }) });
  expect(falsoPositivo.pontos).toBe(50);
  expect(falsoPositivo.score).toBe("morno");

  expect(calcularScoreLead({ ...base, ia_qualificacao: { resultado: "indefinido" } }).pontos).toBe(50);
  expect(lerQualificacaoIA("lixo")).toBeNull();
});
