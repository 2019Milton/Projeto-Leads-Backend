import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buscarTodasPaginasGraph, comLimiteGraph } from "./graph-paginacao";

const simular = (respostas: any[]) => {
  const urls: string[] = [];
  const fetchFn = async (url: string) => {
    urls.push(url);
    const r = respostas.shift();
    if (r instanceof Error) throw r;
    return { json: async () => r };
  };
  return { urls, fetchFn };
};

describe("comLimiteGraph", () => {
  test("acrescenta limit=100 e respeita um limit já informado", () => {
    expect(comLimiteGraph("https://g/me/adaccounts?fields=id&access_token=x")).toBe("https://g/me/adaccounts?fields=id&access_token=x&limit=100");
    expect(comLimiteGraph("https://g/me/accounts")).toBe("https://g/me/accounts?limit=100");
    expect(comLimiteGraph("https://g/c?limit=500&x=1")).toBe("https://g/c?limit=500&x=1");
  });
});

describe("buscarTodasPaginasGraph", () => {
  test("caso real: 49 contas em duas páginas de 25 — junta todas", async () => {
    const contas = Array.from({ length: 49 }, (_, i) => ({ id: `act_${i + 1}` }));
    const { urls, fetchFn } = simular([
      { data: contas.slice(0, 25), paging: { next: "https://g/next-2" } },
      { data: contas.slice(25), paging: {} },
    ]);
    const r = await buscarTodasPaginasGraph("https://g/me/adaccounts?fields=id", { fetchFn });
    expect(r.data.length).toBe(49);
    expect(r.data.findIndex((c: any) => c.id === "act_34")).toBe(33);
    expect(r.error).toBeNull();
    expect(r.incompleto).toBe(false);
    expect(urls).toEqual(["https://g/me/adaccounts?fields=id&limit=100", "https://g/next-2"]);
  });

  test("erro na primeira página: sem dados e com o erro da Meta", async () => {
    const { fetchFn } = simular([{ error: { message: "Error validating access token" } }]);
    const r = await buscarTodasPaginasGraph("https://g/me/adaccounts", { fetchFn });
    expect(r.data).toEqual([]);
    expect(r.error.message).toContain("access token");
    expect(r.incompleto).toBe(false);
  });

  test("erro numa página seguinte: mantém o que já veio e marca incompleto", async () => {
    const { fetchFn } = simular([
      { data: [{ id: 1 }], paging: { next: "https://g/2" } },
      new Error("rede caiu"),
    ]);
    const r = await buscarTodasPaginasGraph("https://g/x", { fetchFn });
    expect(r.data).toEqual([{ id: 1 }]);
    expect(r.error.message).toBe("rede caiu");
    expect(r.incompleto).toBe(true);
  });

  test("para no limite de páginas (next em ciclo)", async () => {
    const respostas = Array.from({ length: 10 }, () => ({ data: [{ id: 1 }], paging: { next: "https://g/mesma" } }));
    const { urls, fetchFn } = simular(respostas);
    const r = await buscarTodasPaginasGraph("https://g/x", { fetchFn, maxPaginas: 3 });
    expect(urls.length).toBe(3);
    expect(r.incompleto).toBe(true);
    expect(r.error).toBeNull();
  });
});

describe("index.ts: listagens da Meta percorrem todas as páginas", () => {
  const fonte = readFileSync(new URL("./index.ts", import.meta.url), "utf8").split("\r\n").join("\n");

  test("nenhuma busca de /me/adaccounts fica só na primeira página", () => {
    const chamadas = fonte.match(/[^\n]*\n[^\n]*graph\.facebook\.com\/v\d+\.\d+\/me\/adaccounts/g) || [];
    expect(chamadas.length).toBeGreaterThan(0);
    for (const c of chamadas) expect(c).toContain("buscarTodasPaginasGraph(");
  });

  test("/me/accounts usa a paginação onde a Página escolhida é procurada na lista", () => {
    const usos = (fonte.match(/buscarTodasPaginasGraph\(\n\s*`https:\/\/graph\.facebook\.com\/v\d+\.\d+\/me\/accounts/g) || []).length;
    expect(usos).toBe(5);
    const listar = fonte.slice(fonte.indexOf("async function listarContasAnuncios("), fonte.indexOf("function normalizarValorMonetarioMeta("));
    expect(listar).toContain("adAccounts.error &&\n    adAccounts.data.length === 0");
  });
});
