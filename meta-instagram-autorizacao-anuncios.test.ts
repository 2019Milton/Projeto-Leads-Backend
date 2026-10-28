import { test, expect } from "bun:test";
import { classificarAutorizacao } from "./meta-instagram-autorizacao-anuncios";
test("autorizacao exige correspondencia", () => {
  expect(classificarAutorizacao({ instagramId:"123", contaAnunciosId:"456", consultaOk:true, identidadesDisponiveis:["123"], autorizacaoConfirmada:true })).toBe("autorizado");
  expect(classificarAutorizacao({ instagramId:"123", contaAnunciosId:"456", consultaOk:true, identidadesDisponiveis:[], autorizacaoConfirmada:true })).toBe("indeterminado");
});
test("pendencia somente confirmada", () => {
  expect(classificarAutorizacao({ instagramId:"123", contaAnunciosId:"456", consultaOk:true, identidadesDisponiveis:[], autorizacaoConfirmada:false, ausenciaConfirmada:true })).toBe("pendente");
  expect(classificarAutorizacao({ instagramId:"123", contaAnunciosId:"456", consultaOk:false, ausenciaConfirmada:true, autorizacaoConfirmada:false })).toBe("indeterminado");
});
