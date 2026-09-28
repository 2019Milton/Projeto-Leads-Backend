import { expect, test } from "bun:test";
import { escolherNichoWhatsApp, menuNichosWhatsApp, garantirLeadWhatsAppSemOrigem, prepararTriagemWhatsApp } from "./whatsapp-sem-origem";
const nichos = [{ id: 2, nome: "Planos de Saúde", slug: "saude" }, { id: 3, nome: "Suplementos", slug: "suplementos" }];
test("entrada sem origem exige assunto claro ou escolha apresentada", () => {
  for (const mensagem of ["Olá! Posso ter mais informações sobre isso?", "Gostaria de informação de plano", "Tenho cnpj", "1", "não quero plano de saúde", "saúde e suplementos"]) {
    expect(escolherNichoWhatsApp(mensagem, nichos)).toBeNull();
  }
  expect(escolherNichoWhatsApp("Quero plano de saúde", nichos)).toBe(2);
  expect(escolherNichoWhatsApp("Suplementos", nichos)).toBe(3);
  expect(escolherNichoWhatsApp("1", nichos, [3, 2])).toBe(3);
  expect(escolherNichoWhatsApp("2", nichos, [3, 2])).toBe(2);
  expect(escolherNichoWhatsApp("3", nichos, [3, 2])).toBeNull();
  expect(menuNichosWhatsApp(nichos)).toContain("1. Planos de Saúde");
});
test("não reutiliza opção cujo roteiro foi desativado", () => {
  expect(escolherNichoWhatsApp("2", [nichos[0]], [2, 3])).toBeNull();
});
test("triagem respeita atendimento humano, campanha e nicho já definidos", async () => {
  for (const registro of [{ status: "humano" }, { status: "encerrada" }, { nicho_id: 3 }, { campanha_id: 205 }, { referral: { source_id: "ad" } }]) {
    let chamadas = 0;
    const pool = { query: async () => { chamadas++; return { rows: [{ status: "bot", ...registro }] }; } };
    expect(await prepararTriagemWhatsApp(pool, 1, 2, "saúde")).toBeNull();
    expect(chamadas).toBe(1);
  }
});
test("primeira mensagem gera menu; resposta seleciona nicho sem atribuir anúncio", async () => {
  const comandos: string[] = [];
  const pool = { query: async (sql: string) => {
    comandos.push(sql);
    if (sql.includes("FROM whatsapp_conversas")) return { rows: [{ status: "bot", lead_id: 10, variaveis: { triagem_nichos: [2, 3] } }] };
    if (sql.includes("SELECT DISTINCT")) return { rows: nichos };
    return { rows: [] };
  } };
  const resultado = await prepararTriagemWhatsApp(pool, 1, 2, "1");
  expect(resultado?.nicho_id).toBe(2);
  expect(comandos.at(-1)).toStartWith("UPDATE leads SET nicho_id=");
  expect(comandos.at(-1)).not.toContain("campanha_id=");
  expect((await prepararTriagemWhatsApp(pool, 1, 2, "oi"))?.pergunta).toBeNull();
});
test("criação idempotente reutiliza vínculo sob lock e não envia mensagens", async () => {
  const comandos: string[] = [];
  const db = { query: async (sql: string) => { comandos.push(sql); return { rows: sql.startsWith("SELECT") ? [{ id: 1, lead_id: 23 }] : [] }; }, release() {} };
  expect(await garantirLeadWhatsAppSemOrigem({ connect: async () => db }, 1, 2)).toBe(23);
  expect(comandos.some(s => s.includes("FOR UPDATE"))).toBeTrue();
  expect(comandos.some(s => s.startsWith("INSERT"))).toBeFalse();
  expect(comandos.at(-1)).toBe("COMMIT");
});
