import { test, expect } from "bun:test";
import { validarWhatsappAdsMeta } from "./meta-whatsapp-numeros-ads";

const normalizar = (v: unknown) => String(v ?? "").replace(/\D/g,"");

test("número adicional conectado com bot pausado pode ser escolhido sem ligar o bot", () => {
 const num = validarWhatsappAdsMeta({
  numero: "+55 11 98093-0205", status: "conectado", bot_ativo: false
 },normalizar);
 expect(num.numero).toBe("5511980930205");
 expect(num.bot_ativo).toBe(false);
 expect(num.aviso_bot).toContain("bot está pausado");
});

test("número principal ligado é aceito sem alerta", () => {
 const num = validarWhatsappAdsMeta({
  numero: "+55 21 96909-9020", status: "conectado", bot_ativo: true
 },normalizar);
 expect(num.numero).toBe("5521969099020");
 expect(num.aviso_bot).toBe(null);
});

test("números desconectados são rejeitados mesmo com bot ativo", () => {
 expect(() => validarWhatsappAdsMeta({
  numero: "+55 11 95964-3372", status: "desconectado", bot_ativo: true
 },normalizar)).toThrow("precisa estar conectado");
});
test("telefone inválido nunca pode ser usado", () => {
 expect(() => validarWhatsappAdsMeta({
  numero: "", status: "conectado", bot_ativo: true
 },normalizar)).toThrow("inválido");
});
