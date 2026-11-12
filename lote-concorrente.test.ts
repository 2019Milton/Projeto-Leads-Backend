import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mapearComLimite } from "./lote-concorrente";

const esperar = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapearComLimite", () => {
  test("respeita o limite de tarefas simultâneas e mantém a ordem", async () => {
    let emAndamento = 0;
    let pico = 0;
    const resultado = await mapearComLimite([50, 10, 30, 5, 20, 1, 15], 3, async (ms, i) => {
      emAndamento++;
      pico = Math.max(pico, emAndamento);
      await esperar(ms);
      emAndamento--;
      return `${i}:${ms}`;
    });
    expect(pico).toBe(3);
    expect(resultado).toEqual(["0:50", "1:10", "2:30", "3:5", "4:20", "5:1", "6:15"]);
  });

  test("é mais rápido que um a um", async () => {
    const inicio = Date.now();
    await mapearComLimite(Array.from({ length: 12 }, () => 40), 6, () => esperar(40));
    expect(Date.now() - inicio).toBeLessThan(40 * 12 / 2);
  });

  test("lista vazia e limite inválido", async () => {
    expect(await mapearComLimite([], 5, async () => 1)).toEqual([]);
    expect(await mapearComLimite([1, 2], 0, async (n) => n * 2)).toEqual([2, 4]);
    expect(await mapearComLimite([1, 2], Number.NaN, async (n) => n * 2)).toEqual([2, 4]);
  });

  test("erro de uma tarefa rejeita o lote", async () => {
    await expect(mapearComLimite([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("falhou");
      return n;
    })).rejects.toThrow("falhou");
  });
});

describe("/meta/metricas-campanhas e servidor", () => {
  const fonte = readFileSync(new URL("./index.ts", import.meta.url), "utf8").split("\r\n").join("\n");
  const inicioRota = fonte.indexOf('app.get("/meta/metricas-campanhas"');
  const rota = fonte.slice(inicioRota, fonte.indexOf("\napp.", inicioRota + 10));

  test("insights da Meta saem do laço e vão em lote limitado", () => {
    expect(rota).toContain("await mapearComLimite(");
    expect(rota).toContain("LIMITE_CAMPANHAS_META_SIMULTANEAS");
    const laco = rota.slice(rota.indexOf("for (const campanha of campanhasConsolidadas) {"));
    expect(laco).not.toContain("graph.facebook.com/v19.0/${campanha.campaign_id}/insights");
    expect(laco).toContain("insightsMetaPorCampanha.get(campanha)");
  });

  test("o servidor não derruba a conexão aos 10 s", () => {
    const serve = fonte.slice(fonte.indexOf("Bun.serve({"), fonte.indexOf("});", fonte.indexOf("Bun.serve({")));
    const idle = Number(/idleTimeout:\s*(\d+)/.exec(serve)?.[1]);
    expect(idle).toBeGreaterThanOrEqual(60);
    expect(idle).toBeLessThanOrEqual(255);
  });
});
