import { expect, test } from "bun:test";
import { juntarPaginasGoogleAds } from "./google-paginacao";

const linhas = (inicio: number, qtd: number) => Array.from({ length: qtd }, (_, i) => ({ n: inicio + i }));

test("uma página só (sem nextPageToken) devolve as linhas e faz uma única chamada", async () => {
  const tokens: Array<string | null> = [];
  const r = await juntarPaginasGoogleAds(async (t) => { tokens.push(t); return { results: linhas(0, 3) }; });
  expect(r.length).toBe(3);
  expect(tokens).toEqual([null]);
});

test("segue o nextPageToken e junta todas as páginas, em ordem", async () => {
  const tokens: Array<string | null> = [];
  const paginas: Record<string, any> = {
    "": { results: linhas(0, 10000), nextPageToken: "p2" },
    p2: { results: linhas(10000, 10000), nextPageToken: "p3" },
    p3: { results: linhas(20000, 1234) }
  };
  const r = await juntarPaginasGoogleAds(async (t) => { tokens.push(t); return paginas[t ?? ""]; });
  expect(r.length).toBe(21234);
  expect(r[0].n).toBe(0);
  expect(r[21233].n).toBe(21233);
  expect(tokens).toEqual([null, "p2", "p3"]);
});

test("resposta sem results (consulta sem linhas) devolve lista vazia", async () => {
  expect(await juntarPaginasGoogleAds(async () => ({}))).toEqual([]);
  expect(await juntarPaginasGoogleAds(async () => ({ results: undefined, nextPageToken: "" }))).toEqual([]);
});

test("token repetido interrompe a paginação em vez de repetir linhas", async () => {
  const avisos: string[] = [];
  let chamadas = 0;
  const r = await juntarPaginasGoogleAds(
    async () => { chamadas++; return { results: linhas(0, 2), nextPageToken: "mesmo" }; },
    { aviso: (m) => avisos.push(m) }
  );
  expect(chamadas).toBe(2);
  expect(r.length).toBe(4);
  expect(avisos.length).toBe(1);
});

test("token que nunca acaba para no limite de páginas e avisa que o resultado é parcial", async () => {
  const avisos: string[] = [];
  let n = 0;
  const r = await juntarPaginasGoogleAds(
    async () => ({ results: linhas(n, 1), nextPageToken: `p${++n}` }),
    { maxPaginas: 5, aviso: (m) => avisos.push(m) }
  );
  expect(r.length).toBe(5);
  expect(avisos[0]).toContain("5 páginas");
});

test("erro numa página propaga (a consulta inteira falha, sem resultado parcial silencioso)", async () => {
  let n = 0;
  await expect(
    juntarPaginasGoogleAds(async () => {
      if (++n === 2) throw new Error("PERMISSION_DENIED");
      return { results: linhas(0, 1), nextPageToken: "x" + n };
    })
  ).rejects.toThrow("PERMISSION_DENIED");
});
