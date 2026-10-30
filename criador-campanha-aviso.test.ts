import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const codigo = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const inicio = codigo.indexOf('app.post("/ia/campanhas/criador"');
const fim = codigo.indexOf("// Direção visual por nicho", inicio);
const rota = codigo.slice(inicio, fim);

describe("criador de campanhas: transparência de IA", () => {
  test("resposta alternativa é rotulada como modelo pronto mesmo em erro inesperado", () => {
    expect(inicio).toBeGreaterThan(0);
    expect(rota.match(/_origem: "modelo_pronto"/g)).toHaveLength(2);
    expect(rota).toContain("não foram geradas por IA");
    expect(rota).toContain("não foram criados pela IA");
  });
  test("não registra mensagem bruta de erro que pode conter parte da chave", () => {
    expect(rota).not.toContain('console.error("CRIADOR CAMPANHA OPENAI ERROR:", data?.error?.message');
    expect(rota).not.toContain('console.error("CRIADOR CAMPANHA ANTHROPIC ERROR:", dataAnthropic?.error?.message');
    expect(rota).toContain('console.error("CRIADOR CAMPANHA OPENAI ERROR: HTTP", resp.status');
    expect(rota).toContain('console.error("CRIADOR CAMPANHA ANTHROPIC ERROR: HTTP", respAnthropic.status');
  });
  test("o fluxo de sucesso continua retornando o provedor real", () => {
    expect(rota).toContain('_origem: "openai"');
    expect(rota).toContain('_origem: "anthropic"');
  });
});
