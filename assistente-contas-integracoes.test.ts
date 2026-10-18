import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
function route(start:string,end:string){const i=source.indexOf(start);if(i<0)throw Error(start);return new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(i,source.indexOf(end,i+start.length)));}
function auth(platform='google',valid=true){
 const handlers:any={},queries:any[]=[],network:any[]=[];
 const context:any=createContext({
 app:{get:(url:string,...fn:any[])=>handlers[url]=fn.at(-1)},console,URLSearchParams,
 Bun:{env:{META_APP_ID:'FAKE',META_APP_SECRET:'FAKE',META_REDIRECT_URI:'https://app.example.invalid/callback',CLIENT:'FAKE',SECRET:'FAKE',REDIRECT:'https://app.example.invalid/callback'}},
 decodificarTokenUsuario:()=>valid?{id:7}:null,tokenPodeOperarContaCompleta:async()=>true,
 OAUTH_PROVEDORES:{google:{clientIdEnv:'CLIENT',clientSecretEnv:'SECRET',redirectUriEnv:'REDIRECT',authUrl:'https://accounts.google.com/o/oauth2/v2/auth',tokenUrl:'https://oauth2.googleapis.com/token',scope:'https://www.googleapis.com/auth/adwords'},tiktok:{clientIdEnv:'CLIENT',clientSecretEnv:'SECRET',redirectUriEnv:'REDIRECT',authUrl:'https://business-api.tiktok.com/portal/auth',tokenUrl:'https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/'}},
 gerarMetaOAuthState:()=> 'random-test',hashMetaOAuthState:()=> 'hash-test',gerarOAuthStateGenerico:()=> 'random-test',hashOAuthStateGenerico:()=> 'hash-test',META_OAUTH_STATE_TTL_MINUTES:10,
 client:{query:async(sql:string,params:any[])=>{queries.push({sql,params});return {rows:[]};},connect:async()=>({query:async(sql:string,params:any[])=>{queries.push({sql,params});return {rows:[]};},release(){}})},
 fetch:async(...args:any[])=>{network.push(args);throw Error('Rede não esperada');},obterFrontendUrl:()=> 'https://app.example.invalid'
 });
 runInContext(route('app.get("/auth/meta/login"','// 🔹 CALLBACK'),context);
 const metaStart=source.indexOf('app.get("/auth/meta/callback"');
 runInContext(new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(metaStart,source.indexOf('\n});',metaStart)+5)),context);
 runInContext(route('app.get("/auth/:plataforma/login"','app.get("/auth/:plataforma/callback"'),context);
 const callbackStart=source.indexOf('app.get("/auth/:plataforma/callback"');
 const callbackEnd=source.indexOf('\n});',callbackStart)+5;
 runInContext(new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(callbackStart,callbackEnd)),context);
 const call=(url:string,query:any)=>handlers[url]({req:{query:(key:string)=>query[key],param:()=>platform},text:(text:string,status=200)=>({text,status}),redirect:(url:string)=>({url,status:302}),html:(html:string)=>({html,status:200})});
 return {call,queries,network};
}
test('OAuth Meta: token inválido bloqueia início antes de criar state',async()=>{const a=auth('meta',false);expect((await a.call('/auth/meta/login',{token:'FAKE'})).status).toBe(401);expect(a.queries.length).toBe(0);});
for(const platform of ['google','tiktok']){
 test('OAuth '+platform+': autorização cancelada retorna erro sem trocar token',async()=>{const a=auth(platform);expect((await a.call('/auth/:plataforma/callback',{error:'access_denied'})).status).toBe(400);expect(a.network.length).toBe(0);});
 test('OAuth '+platform+': state ausente ou inválido bloqueia vínculo',async()=>{const a=auth(platform),query={state:'invalido',code:'FAKE',auth_code:'FAKE'};expect((await a.call('/auth/:plataforma/callback',query)).status).toBe(401);expect(a.network.length).toBe(0);expect(a.queries.some(q=>q.sql.includes('usado_em IS NULL')&&q.sql.includes('expira_em > NOW()'))).toBe(true);});
}
test('OAuth Meta: state inválido bloqueia troca de código',async()=>{const a=auth('meta');expect((await a.call('/auth/meta/callback',{code:'FAKE',state:'invalido'})).status).toBe(401);expect(a.network.length).toBe(0);});
function selectTikTok(options:any={}){
 let handler:any;const queries:any[]=[],network:any[]=[];
 const ctx=createContext({app:{post:(_:string,...f:any[])=>handler=f.at(-1)},authMiddleware(){},console,URLSearchParams,
 client:{query:async(sql:string,params:any[])=>{queries.push({sql,params});return sql.includes('SELECT access_token')?{rows:options.connected?[{access_token:'TOKEN_FICTICIO'}]:[]}:{rows:options.updated?[{usuario_id:7}]:[],rowCount:options.updated?1:0};}},
 tiktokFetch:async(endpoint:string,token:string)=>{network.push({endpoint,token});return options.api||{ok:true,data:{data:{list:[{advertiser_id:'1234567890123456789'}]}}};}
 });
 runInContext(route('app.post("/tiktok/selecionar-anunciante"','// Sincroniza campanhas e leads do TikTok'),ctx);
 return {queries,network,call:(advertiser_id:any)=>handler({get:()=>({id:7}),req:{json:async()=>({advertiser_id})},json:(data:any,status=200)=>({data,status})})};
}
test('TikTok: anunciante vazio é bloqueado',async()=>{const a=selectTikTok();expect((await a.call('')).status).toBe(400);expect(a.queries.length).toBe(0);});
test('REQUISITO: TikTok não pode confirmar seleção sem nenhuma conexão para atualizar',async()=>{const a=selectTikTok();const r=await a.call('9999999999');expect(r.status).not.toBe(200);});
test('REQUISITO: TikTok deve validar acesso ao anunciante antes de gravar ID arbitrário',async()=>{const a=selectTikTok();await a.call('ID_NAO_AUTORIZADO');expect(a.queries.some(q=>q.sql.includes('UPDATE plataforma_conexoes'))).toBe(false);});

test('TikTok valida acesso atual e mantém ID longo sem perda de precisão',async()=>{
 const a=selectTikTok({connected:true,updated:true});expect((await a.call('1234567890123456789')).status).toBe(200);
 const params=new URL(a.network[0].endpoint,'https://example.invalid').searchParams;
 expect(JSON.parse(params.get('advertiser_ids')!)).toEqual(['1234567890123456789']);
 const update=a.queries.find(q=>q.sql.includes('UPDATE plataforma_conexoes'));
 expect(update.params).toEqual(['1234567890123456789',7,'TOKEN_FICTICIO']);
 expect(update.sql).toContain("status = 'conectado'");expect(update.sql).toContain('access_token = $3');
});
test('TikTok não confirma sucesso se conexão desaparecer depois da consulta',async()=>{
 const a=selectTikTok({connected:true});expect((await a.call('1234567890123456789')).status).toBe(409);
});
for(const [name,api,status] of [
 ['token revogado',{ok:false},502],
 ['resposta parcial',{ok:true,data:{}},403],
 ['anunciante diferente',{ok:true,data:{data:{list:[{advertiser_id:'9999999999999999999'}]}}},403],
] as const){
 test('TikTok não grava com '+name,async()=>{
  const a=selectTikTok({connected:true,updated:true,api});expect((await a.call('1234567890123456789')).status).toBe(status);
  expect(a.queries.some(q=>q.sql.includes('UPDATE plataforma_conexoes'))).toBe(false);
 });
}
test('TikTok rejeita IDs numéricos imprecisos, objetos e parâmetros injetados',async()=>{
 const a=selectTikTok({connected:true,updated:true});
 for(const id of [1234567890123456789,{},'123&other=456'])expect((await a.call(id)).status).toBe(400);
 expect(a.queries.length).toBe(0);expect(a.network.length).toBe(0);
});
