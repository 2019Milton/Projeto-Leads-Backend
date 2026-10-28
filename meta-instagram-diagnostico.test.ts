import {test,expect} from "bun:test";
import {resumirConsultaInstagramPagina} from "./meta-instagram-deteccao";
test("pagina com vinculo alternativo gera diagnostico seguro",()=>{
 const resposta = {connected_instagram_account:{id:"178412345",username:"privado"},access_token:"secreto"};
 const diagnostico = resumirConsultaInstagramPagina(resposta,200);
 expect(diagnostico.vinculo).toBe("connected");
 expect(JSON.stringify(diagnostico)).not.toContain("privado");
 expect(JSON.stringify(diagnostico)).not.toContain("secreto");
 expect(JSON.stringify(diagnostico)).not.toContain("178412345");
});
test("erro de permissao nao exibe mensagem bruta",()=>{
 const d = resumirConsultaInstagramPagina({error:{code:10,message:"token secreto"}},403);
 expect(d).toEqual({http:403,vinculo:"nenhum",erro_codigo:10});
});
test("pagina sem instagram retorna nenhum",()=>{
 expect(resumirConsultaInstagramPagina({id:"999"},200).vinculo).toBe("nenhum");
});
