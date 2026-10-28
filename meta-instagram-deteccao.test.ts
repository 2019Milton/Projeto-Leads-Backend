import {test,expect} from "bun:test";
import {escolherInstagramDaContaAnuncios,extrairInstagramVinculadoPagina} from "./meta-instagram-deteccao";
test("uma conta autorizada e reconhecida sem pagina",()=>{
 expect(escolherInstagramDaContaAnuncios([{id:"178400000001",username:"ive"}],null)?.username).toBe("ive");
});
test("varias contas nao sao escolhidas arbitrariamente",()=>{
 expect(escolherInstagramDaContaAnuncios([{id:"1"},{id:"2"}],null)).toBeNull();
});
test("varias contas permitem coincidencia exata da pagina",()=>{
 expect(escolherInstagramDaContaAnuncios([{id:"1"},{id:"2"}],{id:"2"})?.id).toBe("2");
});
test("perfil da pagina que nao pertence a conta nao e escolhido",()=>{
 expect(escolherInstagramDaContaAnuncios([{id:"1"},{id:"2"}],{id:"3"})).toBeNull();
});
test("resposta vazia nao altera a deteccao",()=>{
 expect(escolherInstagramDaContaAnuncios([],null)).toBeNull();
});

test("pagina conectada por settings retorna Instagram mesmo sem business link",()=>{
 expect(extrairInstagramVinculadoPagina({connected_instagram_account:{id:"17840001",username:"ive"}})?.username).toBe("ive");
});
test("instagram_business_account tem prioridade sobre link alternativo",()=>{
 expect(extrairInstagramVinculadoPagina({
  instagram_business_account:{id:"17840002"},
  connected_instagram_account:{id:"17840001"}
 })?.id).toBe("17840002");
});
test("pagina sem id valido nao e tratada como Instagram",()=>{
 expect(extrairInstagramVinculadoPagina({connected_instagram_account:{id:"invalido"}})).toBeNull();
});
