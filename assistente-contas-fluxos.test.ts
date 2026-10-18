import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {validarDadosAssistente,sanitizarAcompanhamentoAssistente} from './assistente-contas';
const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const start=source.indexOf('const ASSISTENTE_CONTAS_PLATAFORMAS =');
const code=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,source.indexOf('app.get("/conexoes"',start)));
const valid={nome_legal:'Empresa fictícia',email:'qa@example.invalid',telefone:'11900000000'};
function suite(options:any={}){
 const handlers:any={},requests:any[]=[],queries:any[]=[],headers:any[]=[];
 const ctx:any=createContext({app:Object.fromEntries(['get','post','put'].map(method=>[method,(url:string,...fns:any[])=>handlers[method+' '+url]=fns.at(-1)])),authMiddleware(){},validarDadosAssistente,sanitizarAcompanhamentoAssistente,AbortSignal,console,
 Bun:{env:{GOOGLE_ADS_DEVELOPER_TOKEN:options.noDeveloper?undefined:'FAKE',OPENAI_API_KEY:options.noVision?undefined:'FAKE'}},
 client:{query:async(sql:string,p:any[])=>{queries.push({sql,p});if(sql.includes('SELECT dados FROM'))return {rows:[{dados:options.invalidDraft?{}:valid}]};if(sql.includes('SELECT refresh_token'))return {rows:options.disconnected?[]:[{refresh_token:'FAKE'}]};if(sql.includes('SELECT conta_anuncios_id'))return {rows:[]};if(sql.includes('SELECT plataforma, status'))return {rows:options.connections||[]};return {rows:[]};}},
 obterAccessTokenGoogle:async()=> 'FAKE',listarContasGoogleAds:async()=>({contas:options.accounts||[{gerenciadora:true,customer_id:'1111111111'}]}),
 criarContaGoogleAssistente:async(deps:any)=>{const response=await deps.criar();return {status:200,data:response.data};},
 GOOGLE_ADS_API:'https://google.example.invalid/v24',googleAdsHeaders:(token:string,login:string)=>{headers.push(login);return {};},
 fetch:async(url:string,options:any)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,status:200,json:async()=>({resourceName:'customers/2222222222'})};},
 tiktokFetch:async()=>({ok:false,data:{code:40001}}),textoOpcional:(v:any)=>v||null,OPENAI_RESPONSES_URL:'https://ia.example.invalid',extrairTextoRespostaOpenAI:(x:any)=>x.output_text,
 fetchProvedorIA:async(_:any,_2:any,url:string,options:any)=>{requests.push({url,body:JSON.parse(options.body)});if(options.providerError)throw Error('mock');return {ok:true,json:async()=>({output_text:JSON.stringify({campos:[],etapa:'Conta',sensivel:false})})};}
 });runInContext(code,ctx);
 return {ctx,requests,queries,headers,call:(method:string,path:string,body:any={},user=1)=>handlers[method+' /assistente-contas-anuncios'+path]({get:()=>({id:user}),req:{json:async()=>body},json:(data:any,status=200)=>({data,status})})};
}
const create={nome:'Empresa fictícia',moeda:'BRL',fuso:'America/Sao_Paulo',manager_customer_id:'1111111111'};
for(const [name,options,status] of [['sem token de desenvolvedor',{noDeveloper:true},503],['sem OAuth',{disconnected:true},400],['MCC inacessível',{accounts:[]},403],['cadastro incompleto',{invalidDraft:true},422]] as const){
 test('Google bloqueia '+name,async()=>{const s=suite(options);expect((await s.call('post','/google/criar',create)).status).toBe(status);expect(s.requests.length).toBe(0);});
}
for(const [field,value] of [['moeda','ZZZ'],['fuso','Invalid/Zone'],['nome',''],['manager_customer_id','']] as const){
 test('Google rejeita '+field+' inválido',async()=>{const s=suite();expect((await s.call('post','/google/criar',{...create,[field]:value})).status).toBe(400);expect(s.requests.length).toBe(0);});
}
test('Google: envia apenas contrato de criação e não CPF, telefone ou cartão',async()=>{
 const s=suite();await s.call('post','/google/criar',{...create,documento:'NAO_ENVIAR',cartao:'NAO_ENVIAR'});
 expect(s.requests[0].body).toEqual({customerClient:{descriptiveName:create.nome,currencyCode:'BRL',timeZone:'America/Sao_Paulo'}});
});
test('REQUISITO: MCC subordinada deve usar a MCC ancestral pela qual o usuário tem acesso',async()=>{
 const s=suite({accounts:[{gerenciadora:true,customer_id:'1111111111',login_customer_id:'9999999999'}]});
 await s.call('post','/google/criar',create);expect(s.headers[0]).toBe('9999999999');
});
test('capacidades: Meta e TikTok nunca anunciam criação automática',async()=>{
 const s=suite();const result=await s.call('get','/capacidades');expect(result.data.capacidades.meta.automatico).toBe(false);expect(result.data.capacidades.tiktok.automatico).toBe(false);
});
test('capacidades: MCC Google acessível permite solicitação sem garantir elegibilidade',async()=>{
 const s=suite({connections:[{plataforma:'google',status:'conectado',refresh_token:'FAKE'}]});const result=await s.call('get','/capacidades');
 expect(result.data.capacidades.google.automatico).toBe(true);expect(result.data.capacidades.google.detalhe).toContain('elegibilidade');
});
for(const [name,body,status] of [['URL externa',{imagem:'https://example.invalid/imagem'},400],['imagem excessiva',{imagem:'data:image/png;base64,'+'A'.repeat(2600000)},413],['plataforma desconhecida',{plataforma:'outra'},400]] as const){
 test('revisão de imagem bloqueia '+name,async()=>{const s=suite();expect((await s.call('post','/analisar-tela',{plataforma:'meta',imagem:'data:image/png;base64,AAAA',imagem_revisada:true,...body})).status).toBe(status);expect(s.requests.length).toBe(0);});
}
test('revisão de imagem trata falta de configuração e intervalo de consultas',async()=>{
 const no=suite({noVision:true});expect((await no.call('post','/analisar-tela',{})).status).toBe(503);
 const s=suite(),body={plataforma:'meta',imagem:'data:image/png;base64,AAAA',imagem_revisada:true};
 expect((await s.call('post','/analisar-tela',body)).status).toBe(200);expect((await s.call('post','/analisar-tela',body)).status).toBe(429);expect(s.requests.length).toBe(1);
});
test('dados solicitados: campos opcionais vazios são aceitos; formatos essenciais conferidos',()=>{
 expect(validarDadosAssistente(valid)).toEqual({});expect(validarDadosAssistente({...valid,pais:'US'}).pais).toBeTruthy();
 expect(validarDadosAssistente({...valid,site:'javascript:alert(1)'}).site).toBeTruthy();
 expect(validarDadosAssistente({...valid,telefone:'abc11900000000'}).telefone).toBeTruthy();
});
