import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const transpiler = new Bun.Transpiler({loader:'ts'});
const routeStart = source.indexOf('app.post("/google/selecionar-conta"');
const routeCode = transpiler.transformSync(source.slice(routeStart, source.indexOf('type PagamentoGoogleAds', routeStart)));
const authStart = source.indexOf('const authMiddleware =');
const authCode = transpiler.transformSync(source.slice(authStart, source.indexOf('const masterMiddleware =', authStart))) + '\nglobalThis.runAuth = authMiddleware;';
const passwordStart = source.indexOf('function tokenEmitidoAntesDaTrocaDeSenha(');
const passwordCode = transpiler.transformSync(source.slice(passwordStart, source.indexOf('function senhaPareceHash(', passwordStart)));

function google(options:any={}) {
  let handler:any;
  const queries:any[]=[];
  const ctx=createContext({
    app:{post:(_:string,_auth:any,fn:any)=>handler=fn}, authMiddleware(){}, console,
    client:{query:async(sql:string,p:any[])=>{
      queries.push({sql,p});
      if(sql.includes('SELECT refresh_token')) return {rows:options.disconnected?[]:[{refresh_token:'FAKE_OLD_CONNECTION'}]};
      if(sql.includes('UPDATE plataforma_conexoes')) return {rows:options.deletedDuringRequest?[]:[{id:1}],rowCount:options.deletedDuringRequest?0:1};
      return {rows:[],rowCount:0};
    }},
    obterAccessTokenGoogle:async()=> 'FAKE_ACCESS',
    listarContasGoogleAds:async()=>({contas:options.inaccessible?[]:[{customer_id:'2222222222',nome:'Empresa fictícia',gerenciadora:false,login_customer_id:'9999999999'}]}),
    googleAdsQuery:async()=>[],
  });
  runInContext(routeCode,ctx);
  return {queries,call:(customer_id='2222222222')=>handler({get:()=>({id:1}),req:{json:async()=>({customer_id})},json:(data:any,status=200)=>({data,status})})};
}

test('Google recusa seleção sem conexão',async()=>{
  const g=google({disconnected:true}); const r=await g.call();
  expect(r.status).toBe(400);expect(g.queries.some(q=>q.sql.includes('UPDATE'))).toBe(false);
});
test('Google recusa conta que a API não retorna como acessível',async()=>{
  const g=google({inaccessible:true}); const r=await g.call();
  expect(r.status).toBe(400);expect(g.queries.some(q=>q.sql.includes('UPDATE'))).toBe(false);
});
test('Google permite seleção válida e usa o usuário autenticado',async()=>{
  const g=google(); const r=await g.call();
  expect(r.data.sucesso).toBe(true);expect(g.queries.find(q=>q.sql.includes('UPDATE plataforma_conexoes')).p).toEqual(['2222222222','9999999999',1,'FAKE_OLD_CONNECTION']);
  expect(g.queries.find(q=>q.sql.includes('UPDATE plataforma_conexoes')).sql).toContain("status = 'conectado'");
  expect(g.queries.find(q=>q.sql.includes('UPDATE plataforma_conexoes')).sql).toContain('refresh_token = $4');
});
test('REQUISITO: Google não confirma vínculo quando a conexão desaparece durante a consulta externa',async()=>{
  const g=google({deletedDuringRequest:true}); const r=await g.call();
  expect(r.data.sucesso).not.toBe(true);
  expect(g.queries.some(q=>q.sql.includes('UPDATE assistente_contas_criacoes'))).toBe(false);
});

async function auth(options:any={}) {
  let passed=false; const assigned:any={}; let queryCount=0;
  const user={id:1,ativo:true,tipo:'usuario',plano:'basico',admin_id:2,painel_cliente_habilitado:true,...options.user};
  const ctx:any=createContext({console,
    TOKEN_TTL_SECONDS:3600,
    decodificarTokenUsuario:()=>options.invalid?null:{id:1,contexto_acesso:options.mode||'normal',gestor_id:2,expira_em:4600},
    client:{query:async()=>({rows:++queryCount===1?[user]:[{id:2,ativo:true,tipo:'gestor',...options.manager}]})},
    normalizarContextoAcesso:(x:string)=>x,usuarioEhGestorVinculado:()=>true,normalizarPlano:(x:string)=>x,obterRecursosPlano:()=>({}),
  });
  runInContext(passwordCode+authCode,ctx);
  const response=await ctx.runAuth({req:{header:()=>options.noHeader?undefined:'Bearer FAKE',path:'/assistente-contas-anuncios',method:'PUT'},set:(k:string,v:any)=>assigned[k]=v,json:(data:any,status:number)=>({data,status})},async()=>{passed=true;});
  return {response,passed,assigned};
}
test('Autorização: sem token bloqueia acesso ao assistente',async()=>{const r=await auth({noHeader:true});expect(r.response.status).toBe(401);expect(r.passed).toBe(false);});
test('Autorização: token inválido bloqueia acesso ao assistente',async()=>{const r=await auth({invalid:true});expect(r.response.status).toBe(401);expect(r.passed).toBe(false);});
test('Autorização: usuário inativo não pode gravar rascunho',async()=>{const r=await auth({user:{ativo:false}});expect(r.response.status).toBe(401);expect(r.passed).toBe(false);});
test('Autorização: painel limitado não pode gravar rascunho',async()=>{const r=await auth({mode:'painel'});expect(r.response.status).toBe(403);expect(r.passed).toBe(false);});
test('Autorização: gestor sem vínculo não pode gravar rascunho',async()=>{const r=await auth({mode:'gestor',user:{admin_id:3}});expect(r.response.status).toBe(403);expect(r.passed).toBe(false);});
test('Autorização: usuário ativo pode continuar como sua própria identidade',async()=>{const r=await auth();expect(r.passed).toBe(true);expect(r.assigned.user.id).toBe(1);});
test('Autorização: senha alterada invalida sessão anterior do dono',async()=>{const r=await auth({user:{senha_alterada_epoch:1100}});expect(r.response.status).toBe(401);expect(r.passed).toBe(false);});
test('Autorização: senha alterada invalida sessão anterior do gestor',async()=>{const r=await auth({mode:'gestor',manager:{senha_alterada_epoch:1100}});expect(r.response.status).toBe(401);expect(r.passed).toBe(false);});
