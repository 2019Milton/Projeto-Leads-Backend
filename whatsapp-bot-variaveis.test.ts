import { expect, test } from "bun:test";
import { capturaNome, normalizarNome, renderizarTextoBot, salvarNomeBot } from "./whatsapp-bot-variaveis";

test("captura explícita; perguntas antigas não viram captura por inferência", () => {
  expect(capturaNome({ tipo: "pergunta", texto: "Nome? [CAPTURAR:nome]" })).toBe(true);
  expect(capturaNome({ tipo: "mensagem", texto: "[CAPTURAR:nome]" })).toBe(false);
  expect(capturaNome({ tipo: "pergunta", texto: "Com quem falo?" })).toBe(false);
});
test("normaliza nomes e rejeita respostas inválidas", () => {
  expect(normalizarNome("  Me chamo João da Silva  ")).toBe("João da Silva");
  expect(normalizarNome("Ana-Maria D’Ávila")).toBe("Ana-Maria D’Ávila");
  for (const v of [undefined, "", "sim", "42", "https://x.com", "A".repeat(81)]) expect(normalizarNome(v)).toBeNull();
});
test("substitui todas as ocorrências sem expor marcador interno", () => {
  expect(renderizarTextoBot("Olá [nome], [NOME]! [CAPTURAR:nome]", { nome: "José" })).toBe("Olá José, José!");
  expect(renderizarTextoBot("Prazer, [nome].")).toBe("Prazer, você.");
  expect(renderizarTextoBot("Olá! [cidade]")).toBe("Olá! [cidade]");
});

// Executa a função real do motor isolada da inicialização do servidor/banco.
const source = await Bun.file(new URL("./index.ts", import.meta.url)).text();
const start = source.indexOf("async function avancarBotWhatsApp(");
const end = source.indexOf("\n// Vincula a conversa", start);
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));
function motor(passos: any[], conversa: any, ativo = 7) {
  const enviados: string[] = [], queries: any[] = [];
  const db = { query: async (sql: string, args: any[]) => {
    queries.push({ sql, args });
    if (sql.includes("SELECT id, passos")) return { rows: [{ id: ativo, passos }] };
    if (sql.includes("WITH captura")) return { rows: [{ variaveis: { nome: args[0] } }] };
    return { rows: [] };
  }};
  const fn = new Function("client", "capturaNome", "normalizarNome", "renderizarTextoBot", "salvarNomeBot", "enviarMensagemWhatsAppOficial", "CORTE_LEGADO_ROTEIRO_BOT_SEM_NICHO", "conversaAvancouBastante", "notificarRetornoLeadAvancado", js + ";return avancarBotWhatsApp;")(
    db, capturaNome, normalizarNome, renderizarTextoBot, salvarNomeBot,
    async (_u: any, _p: any, _t: any, texto: string) => { enviados.push(texto); return `msg${enviados.length}`; },
    "2026-01-01", async () => conversa.passo_atual >= 2, async () => {});
  return { enviados, queries, run: (resposta?: string) => fn(conversa, "phone", 3, resposta) };
}
const passos = [
  { tipo: "pergunta", texto: "Com quem falo? [CAPTURAR:nome]" },
  { tipo: "mensagem", texto: "Prazer, [nome]." },
  { tipo: "pergunta", texto: "[nome], posso prosseguir?", handoff_apos: true },
];
const conversa = (overrides = {}) => ({ id: 1, usuario_id: 2, roteiro_id: 7, passo_atual: 0, status: "aguardando_resposta", ...overrides });
test("resposta salva antes do envio, interpola MSG/PERGUNTA e mantém índice/roteiro", async () => {
  const m = motor(passos, conversa()); await m.run("João");
  expect(m.enviados).toEqual(["Prazer, João.", "João, posso prosseguir?"]);
  expect(m.queries.find(q => q.sql.includes("WITH captura")).args).toEqual(["João", 1, 2, 0, 7]);
  expect(m.queries.at(-1).args).toEqual([2, 7, 1]);
  expect(m.queries.filter(q => q.sql.includes("INSERT INTO whatsapp_mensagens_log")).map(q => q.args[2])).toEqual(m.enviados);
});
test("resposta inválida ou áudio não avança nem altera nome", async () => {
  for (const r of [undefined, "sim", "123"]) {
    const m = motor(passos, conversa()); await m.run(r);
    expect(m.enviados.length).toBe(1);
    expect(m.queries.some(q => q.sql.includes("WITH captura") || q.sql.includes("SET status"))).toBe(false);
  }
});
test("reinício lê variáveis persistidas; pergunta final transfere após resposta", async () => {
  const m = motor(passos, conversa({ passo_atual: 2, variaveis: { nome: "Ana" } })); await m.run("sim");
  expect(m.enviados).toEqual([]);
  expect(m.queries.at(-1).sql).toContain("status = 'humano'");
  const n = motor(passos, conversa({ passo_atual: 1, status: "nova", variaveis: { nome: "Ana" } })); await n.run();
  expect(n.enviados[0]).toBe("Prazer, Ana.");
});
test("troca de roteiro não captura resposta antiga; humanos ficam em silêncio", async () => {
  const m = motor(passos, conversa(), 8); await m.run("Maria");
  expect(m.enviados).toEqual(["Com quem falo?"]);
  expect(m.queries.some(q => q.sql.includes("WITH captura"))).toBe(false);
  for (const status of ["humano", "encerrada"]) {
    const n = motor(passos, conversa({ status })); await n.run("Maria"); expect(n.queries).toEqual([]);
  }
});
test("conversa legada sem roteiro não captura; atualização perdida não avança", async () => {
  const m = motor(passos, conversa({ roteiro_id: null })); await m.run("Maria");
  expect(m.queries.some(q => q.sql.includes("WITH captura"))).toBe(false);
  expect(await salvarNomeBot({ query: async () => ({ rows: [] }) }, conversa(), "Maria")).toBe(false);
});
