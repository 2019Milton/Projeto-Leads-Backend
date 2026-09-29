import { expect, test } from "bun:test";
import {
  avaliarModelo,
  lerConfigContatoFormulario,
  montarMensagemModelo,
  motivoParaNaoContatar,
  primeiroNomeLead,
  renderizarCorpoModelo,
  variantesTelefoneBR
} from "./contato-formulario";

const agora = new Date("2026-09-29T12:00:00Z");
const config = lerConfigContatoFormulario({ ativo: true, template_nome: "primeiro_contato_formulario", template_idioma: "pt_BR", template_corpo: "Olá, {{1}}!", template_variaveis: 1 });
const lead = { lead_id: "123", plataforma: "meta", telefone: "+55 11 98765-4321", criado_em: "2026-09-29T11:50:00Z", whatsapp_contato_enviado_em: null };

test("contata só lead de formulário novo, com telefone, com o recurso ligado", () => {
  expect(motivoParaNaoContatar({ config, lead, agora })).toBeNull();
  expect(motivoParaNaoContatar({ config: lerConfigContatoFormulario(null), lead, agora })).toBe("desativado");
  expect(motivoParaNaoContatar({ config: { ...config, template_nome: null }, lead, agora })).toBe("sem modelo escolhido");
  expect(motivoParaNaoContatar({ config, lead: { ...lead, lead_id: null }, agora })).toBe("não é lead de formulário");
  expect(motivoParaNaoContatar({ config, lead: { ...lead, plataforma: "whatsapp" }, agora })).toBe("não é lead de formulário");
  // Formulário do site do corretor também recebe o primeiro contato.
  expect(motivoParaNaoContatar({ config, lead: { ...lead, lead_id: null, plataforma: "site" }, agora })).toBeNull();
  expect(motivoParaNaoContatar({ config, lead: { ...lead, whatsapp_contato_enviado_em: "2026-09-29T11:55:00Z" }, agora })).toBe("já contatado");
  expect(motivoParaNaoContatar({ config, lead: { ...lead, telefone: "123" }, agora })).toBe("sem telefone válido");
  expect(motivoParaNaoContatar({ config, lead: null, agora })).toBe("lead não encontrado");
});

test("não contata lead antigo reimportado pela sincronização", () => {
  // Sincronização grava criado_em = agora; vale a data da plataforma de origem.
  expect(motivoParaNaoContatar({ config, lead: { ...lead, criado_em: agora.toISOString() }, criadoNaOrigem: "2026-09-01T10:00:00+0000", agora })).toBe("lead antigo");
  expect(motivoParaNaoContatar({ config, lead: { ...lead, criado_em: "2026-09-27T10:00:00Z" }, agora })).toBe("lead antigo");
  expect(motivoParaNaoContatar({ config, lead: { ...lead, criado_em: null }, agora })).toBe("data de criação desconhecida");
});

test("primeiro nome seguro para o parâmetro do modelo", () => {
  expect(primeiroNomeLead("MARIA DA SILVA")).toBe("Maria");
  expect(primeiroNomeLead("  joão  ")).toBe("João");
  expect(primeiroNomeLead("")).toBe("tudo bem");
  expect(primeiroNomeLead("🔥")).toBe("tudo bem");
  expect(primeiroNomeLead(null)).toBe("tudo bem");
  expect(renderizarCorpoModelo("Olá, {{1}}! Tudo certo, {{ 1 }}?", "Ana")).toBe("Olá, Ana! Tudo certo, Ana?");
});

test("avalia se o modelo pode ser preenchido com segurança", () => {
  const corpo = (text: string) => ({ type: "BODY", text });
  expect(avaliarModelo({ status: "APPROVED", components: [corpo("Olá, {{1}}!")] })).toEqual({ compativel: true, motivo: null, corpo: "Olá, {{1}}!", variaveis: 1 });
  expect(avaliarModelo({ status: "APPROVED", components: [corpo("Olá! Recebemos seu cadastro.")] }).compativel).toBe(true);
  expect(avaliarModelo({ status: "PENDING", components: [corpo("Olá")] }).motivo).toBe("ainda não aprovado pela Meta");
  expect(avaliarModelo({ status: "APPROVED", components: [corpo("{{1}} e {{2}}")] }).motivo).toBe("tem mais de uma variável");
  expect(avaliarModelo({ status: "APPROVED", components: [corpo("Olá {{nome}}")] }).motivo).toBe("usa variável com nome (só {{1}} é suportada)");
  expect(avaliarModelo({ status: "APPROVED", components: [{ type: "HEADER", format: "IMAGE" }, corpo("Olá")] }).motivo).toBe("cabeçalho com mídia");
  expect(avaliarModelo({ status: "APPROVED", components: [{ type: "HEADER", format: "TEXT", text: "Oi {{1}}" }, corpo("Olá")] }).motivo).toBe("cabeçalho com variável");
  expect(avaliarModelo({ status: "APPROVED", components: [corpo("Olá"), { type: "BUTTONS", buttons: [{ type: "URL", url: "https://x.com/{{1}}" }] }] }).motivo).toBe("botão que exige preenchimento");
  expect(avaliarModelo({ status: "APPROVED", components: [corpo("Olá"), { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Sim" }] }] }).compativel).toBe(true);
});

test("monta a mensagem de modelo com ou sem parâmetro", () => {
  expect(montarMensagemModelo({ para: "5511987654321", nome: "m", idioma: "pt_BR", variaveis: 1, primeiroNome: "Ana" })).toEqual({
    messaging_product: "whatsapp",
    to: "5511987654321",
    type: "template",
    template: { name: "m", language: { code: "pt_BR" }, components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }] }
  });
  expect(montarMensagemModelo({ para: "55", nome: "m", idioma: "pt_BR", variaveis: 0, primeiroNome: "Ana" }).template).toEqual({ name: "m", language: { code: "pt_BR" } });
});

test("grafias do celular com e sem o 9º dígito", () => {
  expect(variantesTelefoneBR("5511987654321")).toEqual(["5511987654321", "551187654321"]);
  expect(variantesTelefoneBR("551187654321")).toEqual(["551187654321", "5511987654321"]);
  expect(variantesTelefoneBR("551132654321")).toEqual(["551132654321"]); // fixo
  expect(variantesTelefoneBR("")).toEqual([]);
});

test("config inválida ou em texto vira padrão desligado", () => {
  expect(lerConfigContatoFormulario("lixo").ativo).toBe(false);
  expect(lerConfigContatoFormulario('{"ativo":true,"template_nome":"x","template_idioma":"pt_BR","template_variaveis":1}')).toEqual({
    ativo: true, template_nome: "x", template_idioma: "pt_BR", template_corpo: null, template_variaveis: 1
  });
  expect(lerConfigContatoFormulario({ ativo: "true" }).ativo).toBe(false);
});
