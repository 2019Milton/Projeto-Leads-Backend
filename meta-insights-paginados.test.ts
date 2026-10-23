import { expect, test } from "bun:test";
import { consultarInsightsMetaPaginados } from "./meta-insights-paginados";

const url1 = "https://graph.facebook.com/v19.0/act_1/insights?access_token=teste";
const url2 = "https://graph.facebook.com/v19.0/act_1/insights?after=proxima&access_token=teste";

test("recupera registros de todas as paginas sem perder a mais recente", async () => {
  const chamadas: string[] = [];
  const resposta = await consultarInsightsMetaPaginados(url1, async (url) => {
    chamadas.push(url);
    return url === url1
      ? { data: [{ dia: "2026-10-10" }], paging: { next: url2 } }
      : { data: [{ dia: "2026-10-23" }] };
  });
  expect(resposta.paginas).toBe(2);
  expect(resposta.data).toEqual([{ dia: "2026-10-10" }, { dia: "2026-10-23" }]);
  expect(chamadas).toEqual([url1, url2]);
});

test("nao aceita erro Graph como lista vazia", async () => {
  expect(consultarInsightsMetaPaginados(url1, async () => ({
    error: { code: 190, message: "Token expirado" },
  }))).rejects.toThrow("Token expirado");
});

test("bloqueia destinos externos e ciclos de paginacao", async () => {
  expect(consultarInsightsMetaPaginados(url1, async () => ({
    data: [], paging: { next: "https://exemplo.com/?access_token=segredo" },
  }))).rejects.toThrow("invalida");
  expect(consultarInsightsMetaPaginados(url1, async () => ({
    data: [], paging: { next: url1 },
  }))).rejects.toThrow("repetida");
});

test("nao retorna total parcial quando ha paginas demais", async () => {
  expect(consultarInsightsMetaPaginados(url1, async () => ({
    data: [{ id: 1 }], paging: { next: url2 },
  }), 1)).rejects.toThrow("incompleta");
});
