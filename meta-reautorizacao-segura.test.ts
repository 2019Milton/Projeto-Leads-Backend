import {test, expect} from "bun:test";
import {salvarTokenMetaSemPerderVinculos} from "./meta-reautorizacao-segura";
test("reautorizar atualiza somente o token sem remover anuncios ou Instagram",async()=>{
 const chamadas:Array<{sql:string;params:unknown[]}>=[];
 await salvarTokenMetaSemPerderVinculos(async(sql,params)=>{
   chamadas.push({sql,params});return {rows:[{id:17}]};
 },17,"token_teste");
 expect(chamadas).toHaveLength(1);
 expect(chamadas[0].sql).toContain("UPDATE meta_conexoes SET access_token = $1");
 expect(chamadas[0].sql).not.toMatch(/DELETE|instagram_token|conta_anuncios_id/i);
 expect(chamadas[0].params).toEqual(["token_teste",17]);
});
test("primeira autorizacao cria conexao quando nao existe",async()=>{
 const chamadas:string[]=[];
 await salvarTokenMetaSemPerderVinculos(async(sql)=>{
   chamadas.push(sql);
   return {rows:chamadas.length===1?[]:[{id:9}]};
 },9,"token_teste");
 expect(chamadas).toHaveLength(2);
 expect(chamadas[0]).toContain("UPDATE meta_conexoes");
 expect(chamadas[1]).toContain("INSERT INTO meta_conexoes");
});
test("nao escreve conexao com dados invalidos",async()=>{
 let chamadas=0;
 await expect(salvarTokenMetaSemPerderVinculos(async()=>{chamadas++;return {rows:[]};},0,"")).rejects.toThrow();
 expect(chamadas).toBe(0);
});
