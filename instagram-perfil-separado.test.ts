import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const route = source.slice(source.indexOf('  "/meta/status-completo",'));
const projection = route.match(/const instagramSeparado = [\s\S]*?\n      : null;/)?.[0];
if (!projection) throw new Error("Projecao de perfil separada ausente");
const project = (row: any) => vm.runInNewContext(projection + "; JSON.stringify(instagramSeparado)", {conn:{rows:[row]}});

test("retorna apenas perfil OAuth salvo, sem tokens nem identidade de anuncios", () => {
  const row = {instagram_conexao_separada:true, instagram_id:'oauth-123', instagram_username:'conta_oauth', instagram_profile_picture_url:'https://example.com/foto.png', access_token:'segredo-meta', instagram_token:'segredo-ig', conta_anuncios_id:'ads-456'};
  expect(JSON.parse(project(row))).toEqual({id:'oauth-123',username:'conta_oauth',profile_picture_url:'https://example.com/foto.png'});
  expect(project(row)).not.toContain('segredo');
});

test("sem perfil separado retorna null, inclusive com id residual desconectado", () => {
  expect(project({instagram_conexao_separada:false,instagram_id:'residual'})).toBe('null');
  expect(project({instagram_conexao_separada:true,instagram_id:null})).toBe('null');
});

test("contrato inclui perfil com e sem selecao de conta de anuncios", () => {
  expect((route.match(/instagram_perfil_separado: instagramSeparado/g) || []).length).toBe(2);
  expect(route.indexOf('const instagramSeparado')).toBeLessThan(route.indexOf('if (!contaAds)'));
  expect(route).toContain('const instagram = instagramDaConta || instagramDetectadoMeta || instagramSeparado;');
});
