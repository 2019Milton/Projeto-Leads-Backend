import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { validarDadosAssistente, sanitizarAcompanhamentoAssistente } from "./assistente-contas";
const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const start=source.indexOf('const ASSISTENTE_CONTAS_PLATAFORMAS =');
const code=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,source.indexOf('app.get("/conexoes"',start)));
const dados={nome_legal:'Empresa teste',email:'qa@example.invalid',telefone:'11900000000',moeda:'BRL',fuso:'America/Sao_Paulo'};
function rotas(draft:any=dados) {
  const handlers:any={},queries:any[]=[],requests:any[]=[];
  const ctx=createContext({
    app:Object.fromEntries(['get','post','put'].map(method=>[method,(url:string,...fns:any[])=>handlers[method+' '+url]=fns.at(-1)])),
    authMiddleware:()=>{},validarDadosAssistente,sanitizarAcompanhamentoAssistente,
    Bun:{env:{GOOGLE_ADS_DEVELOPER_TOKEN:'teste',OPENAI_API_KEY:'teste'}},AbortSignal,console,
    client:{query:async(sql:string,params:any[])=>{
      queries.push({sql,params});
      if(sql.includes('SELECT dados FROM'))return {rows:[{dados:draft}]};
      if(sql.includes('SELECT refresh_token'))return {rows:[{refresh_token:'teste'}]};
      return {rows:[{atualizado_em:'2026-10-08T00:00:00Z'}]};
    }},
    obterAccessTokenGoogle:async()=> 'teste',listarContasGoogleAds:async()=>({contas:[{gerenciadora:true,customer_id:'1111111111'}]}),
    criarContaGoogleAssistente:async(deps:any)=>{const r=await deps.criar();return {status:r.status,data:{sucesso:true,customer_id:'2222222222'}};},
    GOOGLE_ADS_API:'https://google.example.invalid/vTEST',googleAdsHeaders:()=>({}),
    fetch:async(url:string,options:any)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,status:200,json:async()=>({resourceName:'customers/2222222222'})};},
    textoOpcional:(v:any)=>v||null,OPENAI_RESPONSES_URL:'https://ia.example.invalid',extrairTextoRespostaOpenAI:(x:any)=>x.output_text,
    fetchProvedorIA:async(_:any,_2:any,url:string,options:any)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({output_text:JSON.stringify({campos:[],etapa:'Conta',sensivel:false})})};}
  });
  runInContext(code,ctx);
  const call=(method:string,url:string,body:any={},id=1)=>handlers[method+' /assistente-contas-anuncios'+url]({get:()=>({id}),req:{json:async()=>body},json:(data:any,status=200)=>({data,status})});
  return {call,requests,queries};
}
test('rota bloqueia avanço com cadastro inválido mas preserva edição incompleta',async()=>{
  const r=rotas();expect((await r.call('put','',{etapa:3,dados:{email:'invalido'}})).status).toBe(422);expect(r.queries.length).toBe(0);
  expect((await r.call('put','',{etapa:2,dados:{email:'invalido'}})).status).toBe(200);
});
test('rascunho inclui acompanhamento sanitizado e usa identidade autenticada',async()=>{
  const r=rotas();await r.call('put','',{etapa:3,dados,usuario_id:999,acompanhamento:{meta:{imagem:'privada',historico:[{etapa:'Conta',concluido:true}]}}},7);
  expect(r.queries[0].params[0]).toBe(7);expect(JSON.parse(r.queries[0].params[4]).meta.historico).toEqual([{etapa:'Conta'}]);expect(r.queries[0].params[4]).not.toContain('privada');
});
test('análise sem revisão expressa não chama provedor',async()=>{
  const r=rotas();const result=await r.call('post','/analisar-tela',{plataforma:'meta',imagem:'data:image/png;base64,dGVzdGU='});expect(result.status).toBe(400);expect(r.requests.length).toBe(0);
});
test('análise revisada envia somente a imagem aprovada e não grava imagem no banco',async()=>{
  const r=rotas();const image='data:image/png;base64,dGVzdGU=';expect((await r.call('post','/analisar-tela',{plataforma:'meta',imagem:image,imagem_revisada:true})).status).toBe(200);
  expect(r.requests[0].body.input[0].content[1].image_url).toBe(image);expect(r.requests[0].body.store).toBe(false);expect(r.queries.length).toBe(0);
});
test('Google exige dados empresariais válidos salvos antes de criar',async()=>{
  const r=rotas({});const result=await r.call('post','/google/criar',{nome:'Empresa teste',moeda:'BRL',fuso:'America/Sao_Paulo',manager_customer_id:'1111111111'});expect(result.status).toBe(422);expect(r.requests.length).toBe(0);
});
test('handler Google encaminha contrato correto ao serviço de criação recuperável',async()=>{
  const r=rotas();expect((await r.call('post','/google/criar',{nome:'Empresa teste',moeda:'BRL',fuso:'America/Sao_Paulo',manager_customer_id:'1111111111'})).status).toBe(200);
  expect(r.requests[0].body).toEqual({customerClient:{descriptiveName:'Empresa teste',currencyCode:'BRL',timeZone:'America/Sao_Paulo'}});
});
