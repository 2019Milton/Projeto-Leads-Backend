import test from "node:test";
import assert from "node:assert/strict";
import { inserirRespostaLinkedInUmaVez } from "./linkedin-lead-idempotencia.mjs";

const fixture = {
 usuarioId:17, contaAnunciosId:"123", responseId:"urn:li:leadGenFormResponse:abc",
 nome:"Nome Exemplo",email:"exemplo@example.invalid",telefone:"",campanha:"Teste",
 respostasQualificacao:[{pergunta:"?" ,resposta:"sim"}], nichoId:null,submittedAt:1760000000000
};
function mockPool({duplicate=false,insertError=false}={}) {
 const calls=[];let released=0;
 return {calls,get released(){return released;}, async connect(){return {async query(sql,params=[]){
   calls.push({sql,params});
   if(sql.startsWith("SELECT id FROM leads"))return {rows: duplicate?[{id:1}]:[]};
   if(sql.startsWith("INSERT INTO leads")){
     if(insertError)throw new Error("db insert failed");
     return {rows:[{id:55}]};
   }
   return {rows:[]};
 },release(){released++;}};}};
}
test("insere uma vez com lock transacional por usuário/conta/id",async()=>{
 const db=mockPool();const id=await inserirRespostaLinkedInUmaVez(db,fixture);
 assert.equal(id,55);assert.equal(db.released,1);
 assert.deepEqual(db.calls.map(x=>x.sql.split(" ")[0]),["BEGIN","SELECT","SELECT","INSERT","COMMIT"]);
 assert.match(db.calls[1].sql,/pg_advisory_xact_lock/);
 assert.deepEqual(db.calls[1].params,["17","linkedin:123:urn:li:leadGenFormResponse:abc"]);
 assert.deepEqual(db.calls[2].params,[17,"123",fixture.responseId]);
 assert.equal(db.calls[3].params[0],17);
 assert.equal(db.calls[3].params[1],fixture.responseId);
});
test("não duplica e não envia insert em resposta já conhecida",async()=>{
 const db=mockPool({duplicate:true});
 assert.equal(await inserirRespostaLinkedInUmaVez(db,fixture),null);
 assert.equal(db.calls.some(x=>x.sql.startsWith("INSERT")),false);
 assert.equal(db.released,1);
 assert.equal(db.calls.at(-1).sql,"COMMIT");
});
test("rollback e release quando insert falha",async()=>{
 const db=mockPool({insertError:true});
 await assert.rejects(inserirRespostaLinkedInUmaVez(db,fixture),/db insert failed/);
 assert.equal(db.calls.at(-1).sql,"ROLLBACK");assert.equal(db.released,1);
});
test("sem ID válido não escreve no banco",async()=>{
 const db=mockPool();
 await assert.rejects(inserirRespostaLinkedInUmaVez(db,{...fixture,responseId:""}),/responseId/);
 await assert.rejects(inserirRespostaLinkedInUmaVez(db,{...fixture,usuarioId:0}),/usuarioId/);
 assert.equal(db.calls.length,0);assert.equal(db.released,0);
});
