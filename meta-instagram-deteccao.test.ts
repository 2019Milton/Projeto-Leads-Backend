import {test,expect} from "bun:test";
import {escolherInstagramDaContaAnuncios} from "./meta-instagram-deteccao";
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
