import test from "node:test";
import assert from "node:assert/strict";
import { consultarDestinoWhatsappMeta } from "./meta-destinos-whatsapp.ts";

test("lê números do conjunto e criativo sem alterar a campanha", async () => {
  const chamadas: string[] = [];
  const requisitar = async (url: string, init?: RequestInit): Promise<Response> => {
    chamadas.push(url);
    assert.equal(init?.headers && (init.headers as Record<string,string>).Authorization, "Bearer credencial-test");
    assert.equal(init?.method, undefined);
    const resposta = url.includes("/adsets?")
      ? { data: [{ id: "100", name: "Conjunto", destination_type: "WHATSAPP",
          promoted_object: { whatsapp_phone_number: "5511980930205" }, effective_status: "ACTIVE" }] }
      : { data: [{ id: "200", name: "Criativo", adset_id: "100", effective_status: "ACTIVE",
          creative: { object_story_spec: { link_data: { call_to_action: { value: {
            whatsapp_number: "5511959643372" } } } } } }] };
    return new Response(JSON.stringify(resposta), { status: 200 });
  };
  const dado = await consultarDestinoWhatsappMeta("123456", "credencial-test", requisitar);
  assert.equal(dado.anuncios[0].numero_whatsapp, "5511980930205");
  assert.equal(dado.anuncios[0].fonte_numero, "conjunto");
  assert.equal(dado.somente_leitura, true);
  assert.equal(chamadas.length, 2);
  assert.ok(!JSON.stringify(dado).includes("credencial-test"));
});

test("usa número do link do criativo quando conjunto não informa", async () => {
  const requisitar = async (url: string): Promise<Response> => {
    const resposta = url.includes("/adsets?") ?
      { data: [{ id: "11", destination_type: "WHATSAPP", promoted_object: {} }] } :
      { data: [{ id: "22", adset_id: "11", creative: {
          object_story_spec: { link_data: { call_to_action: {
            value: { link: "https://wa.me/5511959643372?text=oi" } } } } } }] };
    return new Response(JSON.stringify(resposta), { status: 200 });
  };
  const dado = await consultarDestinoWhatsappMeta("123", "token", requisitar);
  assert.equal(dado.anuncios[0].numero_whatsapp, "5511959643372");
  assert.equal(dado.anuncios[0].fonte_numero, "criativo");
});

test("não inventa número de WhatsApp quando ausente", async () => {
  const requisitar = async (url: string): Promise<Response> =>
    new Response(JSON.stringify(url.includes("/ads?") ?
      { data: [{ id: "2", adset_id: "1", creative: {} }] } :
      { data: [{ id: "1", destination_type: "WHATSAPP", promoted_object: {} }] }), { status: 200 });
  const result = await consultarDestinoWhatsappMeta("99", "token", requisitar);
  assert.equal(result.anuncios[0].numero_whatsapp, null);
  assert.equal(result.anuncios[0].fonte_numero, null);
});

test("rejeita identificadores inválidos e paginação de outro domínio", async () => {
  await assert.rejects(() => consultarDestinoWhatsappMeta("1/ads", "token", async () => new Response("{}")));
  const requisitar = async (): Promise<Response> => new Response(
    JSON.stringify({ data: [], paging: { next: "https://nao-e-meta.com/roubar" } }), { status: 200 });
  await assert.rejects(() => consultarDestinoWhatsappMeta("123", "token", requisitar), /Paginação inválida/);
});
