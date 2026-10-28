import { test, expect } from "bun:test";
import { consultarIdentidadeInstagramAds } from "./meta-instagram-consulta-anuncios";
const response = (status: number, value: object) => ({ ok: status >= 200 && status < 300, json: async () => value } as Response);
test("identidade presente na conta ativa", async () => {
 const result = await consultarIdentidadeInstagramAds({contaAnunciosId:"456", instagramId:"123", token:"test", fetchFn:async () => response(200,{data:[{id:"123"}]})});
 expect(result.estado).toBe("autorizado");
});
test("dois inventarios completos sem identidade indicam pendencia", async () => {
 const result = await consultarIdentidadeInstagramAds({contaAnunciosId:"456", instagramId:"123", token:"test", fetchFn:async () => response(200,{data:[]})});
 expect(result.estado).toBe("pendente");
});
test("falha Meta nao comprova pendencia", async () => {
 const result = await consultarIdentidadeInstagramAds({contaAnunciosId:"456", instagramId:"123", token:"test", fetchFn:async () => response(403,{error:{code:200}})});
 expect(result.estado).toBe("indeterminado");
});
test("sem conta ativa nao faz request", async () => {
 const result = await consultarIdentidadeInstagramAds({contaAnunciosId:null, instagramId:"123", token:"test", fetchFn:async () => { throw new Error("request inesperado"); }});
 expect(result.motivo).toBe("CONTA_NAO_SELECIONADA");
});

test("identidade encontrada no edge atual dispensa edge legado", async () => {
 let chamadas = 0;
 const result = await consultarIdentidadeInstagramAds({ contaAnunciosId:"456", instagramId:"123", token:"teste", fetchFn:async () => {
  chamadas++;
  return response(200,{data:[{id:"123"}]});
 }});
 expect(result.estado).toBe("autorizado");
 expect(chamadas).toBe(1);
});
test("sem identidade e erro no segundo edge nao cria pendencia falsa", async () => {
 let chamadas = 0;
 const result = await consultarIdentidadeInstagramAds({ contaAnunciosId:"456", instagramId:"123", token:"teste", fetchFn:async () => {
  chamadas++;
  return chamadas === 1 ? response(200,{data:[]}) : response(403,{error:{code:200}});
 }});
 expect(result.estado).toBe("indeterminado");
});

test("OAuth Instagram separado sem identidade no inventario nao implica pendencia", async () => {
 const result = await consultarIdentidadeInstagramAds({contaAnunciosId:"456", instagramId:"123", token:"test", conexaoSeparada:true, fetchFn:async () => response(200,{data:[]})});
 expect(result.estado).toBe("indeterminado");
});

test("conexao separada sem inventario retorna motivo especifico", async () => {
 const result = await consultarIdentidadeInstagramAds({contaAnunciosId:"456", instagramId:"123", token:"test", conexaoSeparada:true, fetchFn:async () => response(200,{data:[]})});
 expect(result.motivo).toBe("CONEXAO_SEPARADA_SEM_VINCULO_CONFIRMADO");
});

test("login separado pode corresponder pelo mesmo username na conta de anuncios", async () => {
 const result = await consultarIdentidadeInstagramAds({
  contaAnunciosId:"456", instagramId:"123", instagramUsername:"@MMicaSantos10",
  token:"test", conexaoSeparada:true,
  fetchFn:async () => response(200,{data:[{id:"789",username:"mmicasantos10"}]})
 });
 expect(result.estado).toBe("autorizado");
});
test("username diferente nao permite confirmar identidade", async () => {
 const result = await consultarIdentidadeInstagramAds({
  contaAnunciosId:"456", instagramId:"123", instagramUsername:"mmicasantos10",
  token:"test", conexaoSeparada:true,
  fetchFn:async () => response(200,{data:[{id:"789",username:"outra_conta"}]})
 });
 expect(result.estado).toBe("indeterminado");
});
test("username ausente nao autoriza identidade diferente", async () => {
 const result = await consultarIdentidadeInstagramAds({
  contaAnunciosId:"456", instagramId:"123", instagramUsername:null,
  token:"test", conexaoSeparada:true,
  fetchFn:async () => response(200,{data:[{id:"789",username:"mmicasantos10"}]})
 });
 expect(result.estado).toBe("indeterminado");
});
