import { test, expect } from "bun:test";
import { consultarIdentidadeInstagramAds } from "./meta-instagram-consulta-anuncios";
const response = (status: number, value: object) => ({ ok: status >= 200 && status < 300, json: async () => value } as Response);
test("identidade presente na conta ativa", async () => {
 const result = await consultarIdentidadeInstagramAds({contaAnunciosId:"456", instagramId:"123", token:"test", fetchFn:async () => response(200,{data:[{id:"123"}]})});
 expect(result.estado).toBe("autorizado");
});
test("lista vazia nao comprova pendencia", async () => {
 const result = await consultarIdentidadeInstagramAds({contaAnunciosId:"456", instagramId:"123", token:"test", fetchFn:async () => response(200,{data:[]})});
 expect(result.estado).toBe("indeterminado");
});
test("falha Meta nao comprova pendencia", async () => {
 const result = await consultarIdentidadeInstagramAds({contaAnunciosId:"456", instagramId:"123", token:"test", fetchFn:async () => response(403,{error:{code:200}})});
 expect(result.estado).toBe("indeterminado");
});
test("sem conta ativa nao faz request", async () => {
 const result = await consultarIdentidadeInstagramAds({contaAnunciosId:null, instagramId:"123", token:"test", fetchFn:async () => { throw new Error("request inesperado"); }});
 expect(result.motivo).toBe("CONTA_NAO_SELECIONADA");
});
