import test from "node:test";
import assert from "node:assert/strict";
import { garantirLeadWhatsAppSemOrigem } from "./whatsapp-sem-origem.ts";

function bancoFake(multiplos: boolean) {
  let proximoId = 100;
  const conversas = new Map<number, {id:number, lead_id:number|null, telefone_cliente:string}>([
    [1,{id:1,lead_id:null,telefone_cliente:"5511999999999"}],
    [2,{id:2,lead_id:null,telefone_cliente:"5511999999999"}]
  ]);
  const leads: number[] = [];
  const db = {
    async query(sql: string, args: any[] = []): Promise<{rows:any[]}> {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return {rows:[]};
      if (sql.includes("FROM whatsapp_conversas") && sql.includes("FOR UPDATE")) {
        const c = conversas.get(args[0]);return {rows:c ? [{...c}]:[]};
      }
      if (sql.includes("FROM usuarios")) return {rows:[{habilitado:multiplos}]};
      if (sql.includes("SELECT id FROM leads")) return {rows:leads.length ? [{id:leads[0]}]:[]};
      if (sql.includes("INSERT INTO leads")) {
        const id=proximoId++;leads.push(id);return {rows:[{id}]};
      }
      if (sql.includes("UPDATE whatsapp_conversas SET lead_id")) {
        const c=conversas.get(args[1]); if (c) c.lead_id=args[0];
        return {rows:[]};
      }
      throw new Error("Query inesperada: "+sql.slice(0,90));
    },
    release() {}
  };
  return {connect:async()=>db,conversas,leads};
}
test("para dois números, cada conversa ganha um card, mesmo com telefone igual", async () => {
  const banco=bancoFake(true);
  const primeiro=await garantirLeadWhatsAppSemOrigem(banco,1,50);
  const segundo=await garantirLeadWhatsAppSemOrigem(banco,2,50);
  assert.notEqual(primeiro,segundo);
  assert.deepEqual(banco.leads,[primeiro,segundo]);
  assert.equal(await garantirLeadWhatsAppSemOrigem(banco,1,50),primeiro);
  assert.equal(banco.leads.length,2);
});
test("usuário legado mantém reutilização de lead por telefone", async () => {
  const banco=bancoFake(false);
  const um=await garantirLeadWhatsAppSemOrigem(banco,1,50);
  const dois=await garantirLeadWhatsAppSemOrigem(banco,2,50);
  assert.equal(um,dois);
  assert.equal(banco.leads.length,1);
});
