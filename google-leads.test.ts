import { expect, test } from "bun:test";
import { converterDataEnvioLeadGoogle } from "./google-leads";

test("formato documentado pelo Google, com fuso, respeita o fuso", () => {
  expect(converterDataEnvioLeadGoogle("2019-01-01 12:32:45-08:00")).toBe("2019-01-01T20:32:45.000Z");
  expect(converterDataEnvioLeadGoogle("2026-07-29 10:41:13-03:00")).toBe("2026-07-29T13:41:13.000Z");
  expect(converterDataEnvioLeadGoogle("2026-07-29 10:41:13+05:30")).toBe("2026-07-29T05:11:13.000Z");
  expect(converterDataEnvioLeadGoogle("2026-07-29 10:41:13+00:00")).toBe("2026-07-29T10:41:13.000Z");
});

test("sem fuso continua sendo UTC — igual ao que a plataforma sempre fez com os leads já importados", () => {
  expect(converterDataEnvioLeadGoogle("2026-07-29 12:20:27")).toBe("2026-07-29T12:20:27.000Z");
  expect(converterDataEnvioLeadGoogle("2026-07-29T12:20:27")).toBe("2026-07-29T12:20:27.000Z");
});

test("aceita Z, fuso sem dois-pontos, frações e espaços nas pontas", () => {
  expect(converterDataEnvioLeadGoogle("2026-07-29T12:20:27Z")).toBe("2026-07-29T12:20:27.000Z");
  expect(converterDataEnvioLeadGoogle("2026-07-29 12:20:27-0300")).toBe("2026-07-29T15:20:27.000Z");
  expect(converterDataEnvioLeadGoogle("2026-07-29 12:20:27.123456-03:00")).toBe("2026-07-29T15:20:27.123Z");
  expect(converterDataEnvioLeadGoogle("  2026-07-29 12:20:27-03:00  ")).toBe("2026-07-29T15:20:27.000Z");
});

test("valor ilegível ou ausente devolve null em vez de lançar erro", () => {
  for (const ruim of [null, undefined, "", "   ", "ontem", "29/07/2026 12:20", "2026-13-45 99:99:99", "2026-07-29", 12345, {}]) {
    expect(converterDataEnvioLeadGoogle(ruim)).toBeNull();
  }
});

test("nunca lança, qualquer que seja a entrada", () => {
  const entradas: unknown[] = ["2026-07-29 12:20:27-03:00Z", "2026-02-30 10:00:00", "\u0000", [], () => 1];
  for (const entrada of entradas) {
    expect(() => converterDataEnvioLeadGoogle(entrada)).not.toThrow();
  }
});
