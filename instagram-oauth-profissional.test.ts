import {test,expect} from "bun:test";
import {
  AVISO_INSTAGRAM_ACESSO, trocarTokenLongoInstagram, buscarPerfilInstagram,
  criarDiagnosticoInstagram, ErroOAuthInstagram, validarPerfilPorTokensInstagram, type DiagnosticoInstagram
} from "./instagram-oauth-profissional";

const responder = (body: any, status=200) =>
  new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});

test("troca longa por GET conforme caminho padrão da Meta",async()=>{
  const chamadas: string[]=[];
  const req=async(url:string, init?:RequestInit)=>{
    chamadas.push((init?.method||"GET")+" "+url.split("?")[0]);
    return responder({access_token:"token_longo",expires_in:5184000});
  };
  expect(await trocarTokenLongoInstagram("token_curto","segredo",req)).toBe("token_longo");
  expect(chamadas).toEqual(["GET https://graph.instagram.com/access_token"]);
});

test("se Meta recusar GET com 100, tenta POST apenas na troca de token",async()=>{
  const metodos: string[]=[];
  const req=async(_url:string,init?:RequestInit)=>{
    metodos.push(init?.method||"GET");
    if(metodos.length===1) return responder({
      error:{code:100,message:"Unsupported request - method type: get"}
    },400);
    expect(init?.body).toContain("grant_type=ig_exchange_token");
    expect(init?.headers).toEqual({"Content-Type":"application/x-www-form-urlencoded"});
    return responder({access_token:"token_longo_ok"});
  };
  expect(await trocarTokenLongoInstagram("curto","segredo",req)).toBe("token_longo_ok");
  expect(metodos).toEqual(["GET","POST"]);
});

test("falhas GET e POST não marcam conexão como autorizada",async()=>{
  let count=0;
  const req=async()=>{count++;return responder({
    error:{code:100,message:"Unsupported request - method type: get"}
  },400);};
  await expect(trocarTokenLongoInstagram("curto","segredo",req))
    .rejects.toThrow(AVISO_INSTAGRAM_ACESSO);
  expect(count).toBe(2);
});

test("perfil atual usa API v25, id e username conferidos",async()=>{
  const req=async(url:string)=>{
    expect(url).toContain("/v25.0/me?");
    expect(url).toContain("fields=id,user_id,username");
    return responder({user_id:"29164160523276212",username:"lifecorp_supplement"});
  };
  expect(await buscarPerfilInstagram("token","29164160523276212",req)).toEqual({
    user_id:"29164160523276212",username:"lifecorp_supplement",profile_picture_url:null
  });
});

test("perfil com erro 100 tenta GET por ID explícito, nunca POST",async()=>{
  const urls:string[]=[];const methods:string[]=[];
  const req=async(url:string,init?:RequestInit)=>{
    urls.push(url);methods.push(init?.method||"GET");
    if(urls.length===1)return responder({error:{code:100,message:"Unsupported request - method type: get"}},400);
    return responder({id:"29164160523276212",username:"lifecorp_supplement"});
  };
  expect((await buscarPerfilInstagram("token","29164160523276212",req)).username)
    .toBe("lifecorp_supplement");
  expect(methods).toEqual(["GET","GET"]);
  expect(urls[1]).toContain("/v25.0/29164160523276212?");
});

test("perfil inválido ou de outra conta é rejeitado",async()=>{
  await expect(buscarPerfilInstagram("token","29164160523276212",async()=>responder(
    {error:{code:100,message:"Unsupported request - method type: get"}},400
  ))).rejects.toThrow(AVISO_INSTAGRAM_ACESSO);
  await expect(buscarPerfilInstagram("token","29164160523276212",async()=>responder(
    {user_id:"1234",username:"outra_conta"}
  ))).rejects.toThrow("difere");
});

test("nunca aceita somente login sem perfil validado",async()=>{
  await expect(buscarPerfilInstagram("token","29164160523276212",async()=>responder(
    {user_id:"29164160523276212"}
  ))).rejects.toThrow("Resposta inválida");
});

test("diagnóstico distingue GET e POST e preserva código 100 sem analisar mensagem traduzida",async()=>{
  const eventos: DiagnosticoInstagram[]=[];
  let chamadas=0;
  const req=async()=>responder({error:{
    code:100, error_subcode:33, type:"IGApiException", fbtrace_id:"Trace_123-abc",
    message:++chamadas===1 ? "Unsupported request - method type: get" : "Unsupported request - method type: post"
  }},400);
  let falha:unknown;
  try { await trocarTokenLongoInstagram("token_privado","segredo_privado",req,e=>eventos.push(e)); }
  catch(erro) { falha=erro; }
  expect(falha).toBeInstanceOf(ErroOAuthInstagram);
  expect((falha as ErroOAuthInstagram).message).toBe(AVISO_INSTAGRAM_ACESSO);
  expect((falha as ErroOAuthInstagram).diagnostico).toMatchObject({etapa:"long_token_post",codigo:100});
  expect(eventos.map(e=>[e.etapa,e.status_http,e.codigo,e.motivo])).toEqual([
    ["long_token_get",400,100,"metodo_get_nao_suportado"],
    ["long_token_post",400,100,"metodo_post_nao_suportado"]
  ]);
});

test("token longo bem-sucedido é separado das duas falhas posteriores de perfil",async()=>{
  const eventos: DiagnosticoInstagram[]=[];
  const registrar=(e:DiagnosticoInstagram)=>eventos.push(e);
  const longo=await trocarTokenLongoInstagram("curto","segredo",async()=>responder({access_token:"longo"}),registrar);
  let falha:unknown;
  try {
    await buscarPerfilInstagram(longo,"123456",async()=>responder({error:{code:100,
      type:"IGApiException",message:"Unsupported request - method type: get"}},400),registrar);
  } catch(erro) { falha=erro; }
  expect((falha as ErroOAuthInstagram).diagnostico.etapa).toBe("profile_id");
  expect(eventos.map(e=>[e.etapa,e.resultado])).toEqual([
    ["long_token_get","sucesso"],["profile_me","erro_api"],["profile_id","erro_api"]
  ]);
});

test("erro 100 que não recusa o método GET continua sem tentar POST",async()=>{
  const eventos:DiagnosticoInstagram[]=[];
  let chamadas=0;
  await expect(trocarTokenLongoInstagram("curto","segredo",async()=>{
    chamadas++;
    return responder({error:{code:100,message:"Permission denied"}},400);
  },e=>eventos.push(e))).rejects.toThrow(AVISO_INSTAGRAM_ACESSO);
  expect(chamadas).toBe(1);
  expect(eventos[0]).toMatchObject({etapa:"long_token_get",motivo:"acesso_recusado"});
});

test("falha de rede não registra URL nem mensagem da exceção com credenciais",async()=>{
  const eventos:DiagnosticoInstagram[]=[];
  const req=async(url:string)=>{throw new Error("Fetch failed: "+url);};
  let falha:unknown;
  try {await trocarTokenLongoInstagram("token_privado","segredo_privado",req,e=>eventos.push(e));}
  catch(erro) {falha=erro;}
  expect((falha as ErroOAuthInstagram).diagnostico).toMatchObject({etapa:"long_token_get",resultado:"erro_rede",status_http:null});
  const visivel=JSON.stringify(eventos)+(falha as Error).message;
  for(const privado of ["token_privado","segredo_privado","access_token","client_secret","https://"]) {
    expect(visivel).not.toContain(privado);
  }
});

test("diagnóstico permite apenas campos técnicos e não copia mensagens ou payloads privados",()=>{
  const evento=criarDiagnosticoInstagram("profile_me",400,{
    access_token:"token_privado",client_secret:"segredo_privado",user_id:"987654321",
    error:{code:100,error_subcode:33,type:"IGApiException",fbtrace_id:"Trace_123-abc",
      message:"Unsupported request - method type: get https://graph.instagram.com/me?access_token=token_privado&client_secret=segredo_privado",
      error_data:{token:"token_privado"}}
  },"erro_api");
  expect(evento).toEqual({etapa:"profile_me",resultado:"erro_api",status_http:400,codigo:100,
    subcodigo:33,tipo:"IGApiException",motivo:"metodo_get_nao_suportado",fbtrace_id:"Trace_123-abc"});
  const desconhecido=criarDiagnosticoInstagram("profile_me",400,{
    error:{code:"token_privado",type:"segredo_privado",fbtrace_id:"https://privado",message:"segredo_privado"}
  },"erro_api");
  expect(desconhecido).toMatchObject({codigo:null,tipo:null,fbtrace_id:null,motivo:"outro_erro_meta"});
});

test("perfil divergente é identificado sem registrar dados da outra conta",async()=>{
  const eventos:DiagnosticoInstagram[]=[];
  await expect(buscarPerfilInstagram("token_privado","1234",async()=>responder({
    user_id:"5678",username:"perfil_privado",profile_picture_url:"https://privado"
  }),e=>eventos.push(e))).rejects.toThrow("difere");
  expect(eventos[0]).toMatchObject({etapa:"profile_me",resultado:"perfil_divergente",status_http:200});
  expect(JSON.stringify(eventos)).not.toMatch(/5678|perfil_privado|https:\/\/privado|token_privado/);
});


test("id do app corresponde ao OAuth mesmo com user_id diferente",async()=>{
  const eventos: DiagnosticoInstagram[]=[];
  const perfil=await buscarPerfilInstagram("token_privado","123456",async()=>responder({
    id:"123456",user_id:"987654",username:"conta_correta"
  }),e=>eventos.push(e));
  expect(perfil).toEqual({user_id:"123456",username:"conta_correta",profile_picture_url:null});
  expect(eventos).toHaveLength(1);
  expect(eventos[0].resultado).toBe("sucesso");
});

test("user_id corresponde ao OAuth mesmo com id do app diferente",async()=>{
  const perfil=await buscarPerfilInstagram("token","123456",async()=>responder({
    id:"987654",user_id:"123456",username:"conta_correta"
  }));
  expect(perfil.user_id).toBe("123456");
});

test("IDs divergentes continuam bloqueados mesmo se username parecer correto",async()=>{
  await expect(buscarPerfilInstagram("token","123456",async()=>responder({
    id:"888888",user_id:"999999",username:"conta_correta"
  }))).rejects.toThrow("difere");
});

test("diagnostico informa somente qual identificador corresponde, sem revelar IDs",async()=>{
  const eventos: DiagnosticoInstagram[]=[];
  await buscarPerfilInstagram("token_privado","123456",async()=>responder({
    id:"123456",user_id:"987654",username:"teste_privado"
  }),e=>eventos.push(e));
  expect(eventos[0].identidade).toBe("id");
  expect(JSON.stringify(eventos)).not.toMatch(/123456|987654|teste_privado|token_privado/);
});

test("diagnostico de campos sem expor valores",async()=>{
  const eventos: DiagnosticoInstagram[]=[];
  await expect(buscarPerfilInstagram("segredo","123",async()=>responder({id:"999",username:"privado"}),e=>eventos.push(e))).rejects.toThrow("difere");
  expect(eventos[0].campos_identidade).toBe("somente_id");
  expect(JSON.stringify(eventos)).not.toContain("999");
});

test("mesmo perfil em tokens curto e longo é aceito",async()=>{
 const calls:string[]=[];
 const fetchMock=async(url:string)=>{calls.push(url);return responder({id:"123",username:"perfil_profissional"});};
 const perfil=await validarPerfilPorTokensInstagram("curto","longo",fetchMock);
 expect(perfil.user_id).toBe("123");
 expect(calls).toHaveLength(2);
 expect(calls[0]).toContain("access_token=curto");
 expect(calls[1]).toContain("access_token=longo");
});
test("IDs diferentes entre tokens bloqueiam o vínculo",async()=>{
 let i=0;
 await expect(validarPerfilPorTokensInstagram("curto","longo",async()=>responder({id:++i===1?"123":"999",username:"igual"}))).rejects.toThrow("mudou");
});
test("perfil ausente em qualquer token bloqueia o vínculo",async()=>{
 let i=0;
 await expect(validarPerfilPorTokensInstagram("curto","longo",async()=>responder(++i===1?{id:"123",username:"ok"}:{username:"ok"}))).rejects.toThrow();
});

test("mesmo ID com usernames diferentes bloqueia o vínculo",async()=>{
 let n=0;
 await expect(validarPerfilPorTokensInstagram("curto","longo",async()=>
   responder({id:"123",username:++n===1?"perfil_a":"perfil_b"}))).rejects.toThrow("mudou");
});
test("falha do endpoint com token curto bloqueia antes da consulta com token longo",async()=>{
 let n=0;
 await expect(validarPerfilPorTokensInstagram("curto","longo",async()=>{
   n++;
   return responder({error:{code:190,type:"OAuthException",message:"Invalid OAuth access token."}},400);
 })).rejects.toThrow();
 expect(n).toBe(1);
});

test("user_id diferente entre tokens bloqueia mesmo com id igual",async()=>{
 let i=0;
 await expect(validarPerfilPorTokensInstagram("curto","longo",async()=>
   responder({id:"123",user_id:++i===1?"456":"789",username:"igual"}))).rejects.toThrow("mudou");
});
