import { expect, test } from "bun:test";
import { avaliarSaldoIA, mensagemSaldoIA, recargaAutomaticaValida } from "./saldo-ia";

const base = { alertaAbaixoUsd: 3, recargaAutoAbaixoUsd: null, recargaAutoAteUsd: null, alertaBaixoJaEnviado: false };

test("sem recarga automática: avisa uma vez quando a estimativa fica abaixo do limite", () => {
  // OpenAI em 05/10/2026: US$ 10, recarga automática desligada.
  expect(avaliarSaldoIA({ ...base, saldoBaseUsd: 10, gastoDesdeBaseUsd: 6.5 })).toEqual({ estimadoUsd: 3.5, acao: "nenhuma" });
  expect(avaliarSaldoIA({ ...base, saldoBaseUsd: 10, gastoDesdeBaseUsd: 7.2 })).toEqual({ estimadoUsd: 2.8, acao: "avisar_baixo" });
  expect(avaliarSaldoIA({ ...base, saldoBaseUsd: 10, gastoDesdeBaseUsd: 7.2, alertaBaixoJaEnviado: true }).acao).toBe("nenhuma");
  // Sem limite configurado, nunca avisa (o erro real de "sem crédito" continua avisando).
  expect(avaliarSaldoIA({ ...base, alertaAbaixoUsd: null, saldoBaseUsd: 10, gastoDesdeBaseUsd: 9.9 }).acao).toBe("nenhuma");
});

test("com recarga automática: ao cruzar o gatilho, presume a recarga", () => {
  // Anthropic em 05/10/2026: US$ 17,62, recarrega até US$ 50 quando fica abaixo de US$ 10.
  const anthropic = { ...base, recargaAutoAbaixoUsd: 10, recargaAutoAteUsd: 50 };
  expect(avaliarSaldoIA({ ...anthropic, saldoBaseUsd: 17.62, gastoDesdeBaseUsd: 7 }).acao).toBe("nenhuma");
  expect(avaliarSaldoIA({ ...anthropic, saldoBaseUsd: 17.62, gastoDesdeBaseUsd: 7.7 })).toEqual({ estimadoUsd: 9.92, acao: "recarga_automatica" });
  // Mesmo abaixo do limite de aviso, a recarga automática vem primeiro.
  expect(avaliarSaldoIA({ ...anthropic, saldoBaseUsd: 17.62, gastoDesdeBaseUsd: 15 }).acao).toBe("recarga_automatica");
});

test("recarga automática só vale com \"até\" maior que \"abaixo de\"", () => {
  expect(recargaAutomaticaValida(10, 50)).toBe(true);
  expect(recargaAutomaticaValida(50, 10)).toBe(false);
  expect(recargaAutomaticaValida(null, 50)).toBe(false);
  expect(recargaAutomaticaValida(10, 0)).toBe(false);
  // Configuração inválida é ignorada: cai no aviso de saldo baixo.
  expect(avaliarSaldoIA({ ...base, recargaAutoAbaixoUsd: 50, recargaAutoAteUsd: 10, saldoBaseUsd: 5, gastoDesdeBaseUsd: 3 }).acao).toBe("avisar_baixo");
});

test("mensagens do WhatsApp", () => {
  const baixo = mensagemSaldoIA({ nomeProvedor: "OpenAI", acao: "avisar_baixo", estimadoUsd: 2.8, alertaAbaixoUsd: 3, linkBilling: "https://x/billing" });
  expect(baixo.titulo).toBe("IA: OpenAI — saldo baixo");
  expect(baixo.whatsapp).toContain("US$ 2,80");
  expect(baixo.whatsapp).toContain("US$ 3,00");
  expect(baixo.whatsapp).toContain("https://x/billing");
  const recarga = mensagemSaldoIA({ nomeProvedor: "Anthropic", acao: "recarga_automatica", estimadoUsd: 9.92, recargaAutoAbaixoUsd: 10, recargaAutoAteUsd: 50, linkBilling: "https://y" });
  expect(recarga.whatsapp).toContain("recarga automática provavelmente feita");
  expect(recarga.whatsapp).toContain("US$ 50,00");
});
