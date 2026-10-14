import {test,expect} from "bun:test";
import {alterarStatusItemMeta} from "./meta-controle-veiculacao";
const res=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status});
const comum={campanhaId:"500",contaAdsId:"act_900",token:"mock"} as const;
const setP={...comum,itemId:"321",tipo:"conjunto" as const,
 statusEsperado:"PAUSED" as const,statusDesejado:"ACTIVE" as const};
const adP={...comum,itemId:"654",tipo:"anuncio" as const,
 statusEsperado:"PAUSED" as const,statusDesejado:"ACTIVE" as const};

test("ativa conjunto pausado só quando possui anúncio configurado ACTIVE, com 1 POST de status",async()=>{
 const posts:any[]=[];
 const req=async(url:string,init?:RequestInit)=>{
  if(url.includes("/321?"))return res({id:"321",campaign_id:"500",account_id:"900",status:"PAUSED"});
  if(url.includes("/321/ads?"))return res({data:[{id:"654",status:"ACTIVE"}]});
  if(init?.method==="POST"){const body=new URLSearchParams(String(init.body));posts.push(body);
   return res({success:true});}
  return res({},404);
 };
 const result=await alterarStatusItemMeta(setP,req);
 expect(result).toMatchObject({ok:true,tipo:"conjunto",item_id:"321",status_solicitado:"ACTIVE"});
 expect(posts).toHaveLength(1);
 expect([...posts[0].keys()]).toEqual(["status"]);
 expect(posts[0].get("status")).toBe("ACTIVE");
});
test("bloqueia ativar conjunto com anúncio pausado ou sem anúncio",async()=>{
 let posts=0;
 const req=async(url:string,init?:RequestInit)=>{
  if(init?.method==="POST")posts++;
  if(url.includes("/321?"))return res({id:"321",campaign_id:"500",account_id:"900",status:"PAUSED"});
  return res({data:[{id:"654",status:"PAUSED"}]});
 };
 await expect(alterarStatusItemMeta(setP,req)).rejects.toThrow("Ative primeiro");
 expect(posts).toBe(0);
});
test("ativa anúncio mantendo conjunto pausado e orçamento intacto",async()=>{
 let posts=0;
 const req=async(url:string,init?:RequestInit)=>{
  if(url.includes("/654?"))return res({
   id:"654",campaign_id:"500",account_id:"900",adset_id:"321",status:"PAUSED"
  });
  if(url.includes("/321?"))return res({id:"321",campaign_id:"500",account_id:"900",status:"PAUSED"});
  if(init?.method==="POST"){posts++;expect(String(init.body)).toBe("status=ACTIVE");return res({success:true});}
  return res({},404);
 };
 const result=await alterarStatusItemMeta(adP,req);
 expect(result.ok).toBe(true);
 expect(posts).toBe(1);
});
test("pausa item diretamente sem verificar anúncios e sem alterar orçamento",async()=>{
 let posts=0;
 const req=async(url:string,init?:RequestInit)=>{
  if(init?.method==="POST"){posts++;expect(String(init.body)).toBe("status=PAUSED");return res({success:true});}
  return res({id:"321",campaign_id:"500",account_id:"900",status:"ACTIVE"});
 };
 const result=await alterarStatusItemMeta({...setP,statusEsperado:"ACTIVE",statusDesejado:"PAUSED"},req);
 expect(result.ok).toBe(true);
 expect(posts).toBe(1);
});
test("não permite modificar item fora da campanha ou de outra conta",async()=>{
 let posts=0;
 const req=async(url:string,init?:RequestInit)=>{
  if(init?.method==="POST")posts++;
  return res({id:"321",campaign_id:"500",account_id:"111",status:"PAUSED"});
 };
 await expect(alterarStatusItemMeta(setP,req)).rejects.toThrow("não pertence");
 expect(posts).toBe(0);
});
test("não permite status desatualizado ou operação repetida",async()=>{
 let posts=0;
 const req=async(url:string,init?:RequestInit)=>{
  if(init?.method==="POST")posts++;
  return res({id:"321",campaign_id:"500",account_id:"900",status:"ACTIVE"});
 };
 await expect(alterarStatusItemMeta(setP,req)).rejects.toThrow("alterado");
 expect(posts).toBe(0);
});
test("erro 613 da Meta interrompe fluxo sem tentar novamente",async()=>{
 let posts=0;
 const req=async(url:string,init?:RequestInit)=>{
  if(init?.method==="POST"){posts++;return res({error:{code:613,message:"Calls to this API have exceeded the concurrent request rate limit of 1 calls per 30 seconds."}},400);}
  return res({id:"321",campaign_id:"500",account_id:"900",status:"ACTIVE"});
 };
 await expect(alterarStatusItemMeta({...setP,statusEsperado:"ACTIVE",statusDesejado:"PAUSED"},req))
   .rejects.toThrow("30 segundos");
 expect(posts).toBe(1);
});
test("Meta não confirmar success true nunca é tratado como ativação",async()=>{
 const req=async(url:string,init?:RequestInit)=>{
  if(init?.method==="POST")return res({success:false},200);
  return res({id:"321",campaign_id:"500",account_id:"900",status:"ACTIVE"});
 };
 await expect(alterarStatusItemMeta({...setP,statusEsperado:"ACTIVE",statusDesejado:"PAUSED"},req))
   .rejects.toThrow("não confirmou");
});
