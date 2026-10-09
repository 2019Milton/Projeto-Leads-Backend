import { expect, test } from "bun:test";
import { documentoAssistenteValido, validarDadosAssistente, sanitizarAcompanhamentoAssistente, criarContaGoogleAssistente } from "./assistente-contas";

const dados = { nome_legal: "Empresa de teste", email: "qa@example.invalid", telefone: "(11) 90000-0000", site: "https://example.invalid", moeda: "BRL", fuso: "America/Sao_Paulo" };
test("cadastro válido; telefone internacional e campos opcionais", () => {
  expect(validarDadosAssistente(dados)).toEqual({});
  expect(validarDadosAssistente({ ...dados, telefone: "+1 202 555 0199", site: "" })).toEqual({});
});
test("campos vazios e formatos inválidos impedem validação do cadastro", () => {
  expect(Object.keys(validarDadosAssistente({}))).toEqual(["nome_legal", "email", "telefone"]);
  expect(Object.keys(validarDadosAssistente({ ...dados, email: "invalido", telefone: "1", documento: "123", site: "javascript:alert(1)" }))).toEqual(["email", "telefone", "documento", "site"]);
  expect(validarDadosAssistente({ ...dados, telefone: "abc11900000000" }).telefone).toBeTruthy();
});
test("CPF/CNPJ verificam dígitos, inclusive CNPJ alfanumérico da Receita", () => {
  expect(documentoAssistenteValido("529.982.247-25")).toBe(true);
  expect(documentoAssistenteValido("11.222.333/0001-81")).toBe(true);
  expect(documentoAssistenteValido("12.ABC.345/01DE-35")).toBe(true);
  expect(documentoAssistenteValido("12.ABC.345/01DE-36")).toBe(false);
  expect(documentoAssistenteValido("000.000.000-00")).toBe(false);
  expect(documentoAssistenteValido("529.982.247-26")).toBe(false);
});
test("histórico guarda apenas rótulos, estados e datas; nunca imagem ou valores", () => {
  const atual = sanitizarAcompanhamentoAssistente({ meta: { imagem:"base64-secreto", resultado:"livre", checklist:[{nome:"E-mail",status:"preenchido",valor:"a@b.com",orientacao:"dados privados"}], historico:[{etapa:"Conta",concluido:true}], atualizado_em:"2026-10-08T00:00:00Z" }, outra:{historico:[]} });
  expect(atual).toEqual({meta:{checklist:[{nome:"E-mail",status:"preenchido"}],historico:[{etapa:"Conta"}],atualizado_em:"2026-10-08T00:00:00.000Z"}});
});

// Simula falhas entre as gravações e a API. Cada chamada usa uma nova instância
// do serviço, compartilhando somente o repositório, como em dois processos.
function repositorio() {
  const registros: any[] = [];
  const vinculos: any[] = [];
  let falhaVinculo = false, falhaRegistro = false;
  const query = async (sql: string, p: any[]) => {
    if (sql.includes("INSERT INTO assistente_contas_criacoes")) {
      if (registros.some(r=>r.usuario_id===p[0] && (r.chave===p[1] || ["em_andamento","incerta","criada"].includes(r.estado)))) return {rows:[]};
      const row={usuario_id:p[0],chave:p[1],dados:JSON.parse(p[2]),estado:"em_andamento",customer_id:null};
      registros.push(row);return {rows:[{...row}]};
    }
    if(sql.includes("SELECT * FROM assistente_contas_criacoes")) {
      const row=registros.find(r=>r.usuario_id===p[0]&&r.chave===p[1]) || registros.find(r=>r.usuario_id===p[0]&&["em_andamento","incerta","criada"].includes(r.estado));
      return {rows:row?[{...row}]:[]};
    }
    if(sql.includes("UPDATE plataforma_conexoes")) {
      if(falhaVinculo)throw Error("Banco indisponível para vínculo");
      vinculos.push([...p]);return {rows:[{usuario_id:p[2]}]};
    }
    if(sql.includes("UPDATE assistente_contas_criacoes")) {
      const row=registros.find(r=>r.usuario_id===p[0]&&r.chave===p[1]);
      if(!row)throw Error("Operação inexistente");
      if(sql.includes("customer_id = $3")) {if(falhaRegistro)throw Error("Falha ao registrar ID");row.customer_id=p[2];row.estado="criada";}
      else if(sql.includes("estado = $3"))row.estado=p[2];
      else if(sql.includes("estado = 'incerta'"))row.estado="incerta";
      else if(sql.includes("estado = 'vinculada'"))row.estado="vinculada";
      else if(sql.includes("SET estado = 'em_andamento'")) {
        if(row.estado!=="recusada")return {rows:[]};
        if(registros.some(r=>r!==row&&r.usuario_id===p[0]&&["em_andamento","incerta","criada"].includes(r.estado)))throw Object.assign(Error("Reserva em uso"),{code:"23505"});
        row.estado="em_andamento";
      }
      return {rows:[{...row}]};
    }
    throw Error("SQL inesperado: "+sql);
  };
  return {query,registros,vinculos, falharVinculo:(v:boolean)=>falhaVinculo=v, falharRegistro:(v:boolean)=>falhaRegistro=v};
}
const conta = {nome:"Empresa teste", moeda:"BRL",fuso:"America/Sao_Paulo",managerCustomerId:"1111111111"};
const sucesso = {ok:true,status:200,data:{resourceName:"customers/2222222222"}};
test("repetições com mesma empresa recuperam a mesma conta sem criar de novo", async () => {
  const repo=repositorio();let criacoes=0;
  const executar=()=>criarContaGoogleAssistente({query:repo.query,usuarioId:1,dados:conta,criar:async()=>{criacoes++;return sucesso;}});
  expect((await executar()).status).toBe(200);
  expect((await executar()).data.reutilizada).toBe(true);
  expect(criacoes).toBe(1);
  expect(repo.vinculos[0]).toEqual(["2222222222","1111111111",1]);
});
test("falha no vínculo não duplica e permite recuperação em outra chamada", async () => {
  const repo=repositorio();let criacoes=0;
  const executar=()=>criarContaGoogleAssistente({query:repo.query,usuarioId:1,dados:conta,criar:async()=>{criacoes++;return sucesso;}});
  repo.falharVinculo(true);
  expect((await executar()).data.vinculo_pendente).toBe(true);
  repo.falharVinculo(false);
  expect((await executar()).status).toBe(200);
  expect(criacoes).toBe(1);
});
test("falha ao registrar ID conserva reserva e informa ID ao usuário", async () => {
  const repo=repositorio();let criacoes=0;
  const executar=()=>criarContaGoogleAssistente({query:repo.query,usuarioId:1,dados:conta,criar:async()=>{criacoes++;return sucesso;}});
  repo.falharRegistro(true);
  const primeiro=await executar();expect(primeiro.status).toBe(202);expect(primeiro.data.customer_id).toBe("2222222222");
  repo.falharRegistro(false);
  expect((await executar()).status).toBe(409);
  expect(criacoes).toBe(1);
});
test("timeout ou resposta incerta bloqueia nova criação até reconciliação", async () => {
  const repo=repositorio();let criacoes=0;
  const executar=(nome=conta.nome)=>criarContaGoogleAssistente({query:repo.query,usuarioId:1,dados:{...conta,nome},criar:async()=>{criacoes++;throw Error("timeout");}});
  expect((await executar()).status).toBe(409);
  expect((await executar()).status).toBe(409);
  expect((await executar("Outro nome")).status).toBe(409);
  expect(criacoes).toBe(1);
});
test("concorrência em dois processos disputa uma reserva durável", async () => {
  const repo=repositorio();let release!:()=>void, criacoes=0;
  const aguardar=new Promise<void>(r=>release=r);
  const executar=()=>criarContaGoogleAssistente({query:repo.query,usuarioId:1,dados:conta,criar:async()=>{criacoes++;await aguardar;return sucesso;}});
  const a=executar();await Promise.resolve();
  expect((await executar()).status).toBe(409);
  release();expect((await a).status).toBe(200);expect(criacoes).toBe(1);
});
test("rejeição explícita da API permite nova tentativa após ajuste externo", async () => {
  const repo=repositorio();let criacoes=0;
  const executar=()=>criarContaGoogleAssistente({query:repo.query,usuarioId:1,dados:conta,criar:async()=>++criacoes===1?{ok:false,status:403,data:{error:{message:"Permissão negada"}}}:sucesso});
  expect((await executar()).status).toBe(400);expect((await executar()).status).toBe(200);expect(criacoes).toBe(2);
});
test("usuários diferentes nunca recuperam a conta um do outro", async () => {
  const repo=repositorio();let criacoes=0;
  for(const usuarioId of [1,2])await criarContaGoogleAssistente({query:repo.query,usuarioId,dados:conta,criar:async()=>{criacoes++;return sucesso;}});
  expect(criacoes).toBe(2);expect(repo.registros.length).toBe(2);
});

test("repetir operação recusada não ignora outra criação pendente", async () => {
  const repo=repositorio();let criacoes=0;
  await criarContaGoogleAssistente({query:repo.query,usuarioId:1,dados:conta,criar:async()=>({ok:false,status:403,data:{}})});
  await criarContaGoogleAssistente({query:repo.query,usuarioId:1,dados:{...conta,nome:"Outra conta"},criar:async()=>{throw Error("Timeout");}});
  const resultado=await criarContaGoogleAssistente({query:repo.query,usuarioId:1,dados:conta,criar:async()=>{criacoes++;return sucesso;}});
  expect(resultado.status).toBe(409);expect(criacoes).toBe(0);
});
