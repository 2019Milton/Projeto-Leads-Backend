import {test,expect} from "bun:test";
import {
  AVISO_INSTAGRAM_ACESSO, trocarTokenLongoInstagram, buscarPerfilInstagram
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
