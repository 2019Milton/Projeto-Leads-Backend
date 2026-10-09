const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { stripTypeScriptTypes } = require("node:module");

const source = fs.readFileSync(path.join(__dirname, "index.ts"),"utf8");
const inicio = source.indexOf("async function obterNumeroWhatsappConectadoUsuario(");
const fim = source.indexOf("// Objetivo da campanha:",inicio);
assert.ok(inicio > 0 && fim > inicio);
const codigo = stripTypeScriptTypes(source.slice(inicio,fim),{mode:"transform"});
function fixture(enabled = true) {
  const banco = {
    async query(sql,params) {
      if(sql.includes("FROM usuarios")) return {rows:[{whatsapp_multiplos_numeros_habilitado:enabled}]};
      if(sql.includes("FROM whatsapp_numeros")) {
        const [,id] = params;
        return {rows:id===2 ? [{numero:"+55 11 98093-0205"}] :[]};
      }
      if(sql.includes("FROM plataforma_conexoes")) return {rows:[{numero:"+55 21 96909-9020"}]};
      throw Error("Query inesperada "+sql.slice(0,80));
    }
  };
  const ctx={client:banco,normalizarTelefoneWhatsApp:(value) =>
    String(value||"").replace(/\D/g,"")};
  vm.createContext(ctx);
  vm.runInContext(codigo+"; globalThis.resolverNumero = obterNumeroWhatsappConectadoUsuario;",ctx);
  return ctx.resolverNumero;
}
test("seleciona o número adicional autorizado da campanha", async () => {
  assert.equal(await fixture(true)(50,2),"5511980930205");
});
test("preserva principal quando não há escolha específica", async () => {
  assert.equal(await fixture(true)(50,null),"5521969099020");
});
test("não escolhe número adicional inexistente ou desabilitado", async () => {
  assert.equal(await fixture(true)(50,999),"");
  assert.equal(await fixture(false)(50,2),"");
});
