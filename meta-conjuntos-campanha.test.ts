import { test, expect } from "bun:test";
import {
  listarConjuntosCampanhaMeta,
  montarConjuntoWhatsappPausado,
  criarConjuntoWhatsappPausadoMeta
} from "./meta-conjuntos-campanha";

const origem = {
  id:"100",campaign_id:"123", destination_type:"WHATSAPP",
  promoted_object:{page_id:"321",whatsapp_phone_number:"5521969099020"},
  targeting:{geo_locations:{countries:["BR"]},age_min:25},
  billing_event:"IMPRESSIONS",optimization_goal:"CONVERSATIONS"
};
const resposta = (json:any, status=200) => new Response(JSON.stringify(json), {status,headers:{"content-type":"application/json"}});

test("lista conjuntos originais e novos com números e métricas individuais sem POST", async () => {
  const chamadas:string[] = [];
  const req = async (u:string, init?:RequestInit) => {
    chamadas.push((init?.method || "GET") + " " + u);
    if (u.includes("/123/adsets")) return resposta({data:[
      {id:"100",name:"Atual",status:"ACTIVE",effective_status:"ACTIVE",destination_type:"WHATSAPP",promoted_object:{whatsapp_phone_number:"5521969099020"}},
      {id:"101",name:"Suplementos A",status:"PAUSED",effective_status:"PAUSED",destination_type:"WHATSAPP",promoted_object:{whatsapp_phone_number:"5511980930205"}}
    ]});
    if (u.includes("/123/ads")) return resposta({data:[{id:"888",name:"Criativo Atual",adset_id:"100",status:"ACTIVE",effective_status:"ACTIVE"}]});
    if (u.includes("/123/insights")) return resposta({data:[
      {adset_id:"100",spend:"12.33",clicks:"20",impressions:"300",ctr:"4.5"},
      {adset_id:"101",spend:"0.00",clicks:"0",impressions:"0",ctr:"0"}
    ]});
    if (u.includes("/123?fields")) return resposta({id:"123",name:"Campanha 63",daily_budget:"5000",objective:"OUTCOME_ENGAGEMENT"});
    return resposta({},404);
  };
  const dados = await listarConjuntosCampanhaMeta("123","token",req);
  expect(dados.conjuntos).toHaveLength(2);
  expect(dados.campanha.cbo).toBe(true);
  expect(dados.conjuntos[0].numero_whatsapp).toBe("5521969099020");
  expect(dados.conjuntos[1].numero_whatsapp).toBe("5511980930205");
  expect(dados.conjuntos[0].metricas.gasto).toBe(12.33);
  expect(dados.conjuntos[1].anuncios).toEqual([]);
  expect(chamadas.every(x=>x.startsWith("GET "))).toBe(true);
  expect(chamadas.some(x=>x.includes("level=adset"))).toBe(true);
});

test("se métricas falharem mantém listagem de conjuntos", async () => {
  const req=async (u:string) => {
    if (u.includes("/123/adsets")) return resposta({data:[{id:"100",name:"Atual"}]});
    if (u.includes("/123/ads")) return resposta({data:[]});
    if (u.includes("/123/insights")) return resposta({error:{code:17}},400);
    return resposta({id:"123",daily_budget:"5000"});
  };
  const r=await listarConjuntosCampanhaMeta("123","token",req);
  expect(r.conjuntos).toHaveLength(1);
  expect(r.aviso_metricas).toBeTruthy();
});

test("monta novo conjunto pausado com CBO, copia público e troca o WhatsApp", () => {
  const r=montarConjuntoWhatsappPausado(origem,{id:"123",daily_budget:"5000"},
    "5511980930205","DIHOR 0205",null);
  expect(r.cbo).toBe(true);
  expect(r.payload.status).toBe("PAUSED");
  expect(r.payload.promoted_object.whatsapp_phone_number).toBe("5511980930205");
  expect(r.payload.targeting).toEqual(origem.targeting);
  expect(r.payload.daily_budget).toBeUndefined();
});

test("ABO exige orçamento explícito e fonte com WhatsApp dentro da campanha", () => {
  expect(()=>montarConjuntoWhatsappPausado(origem,{id:"123"},
    "5511959643372","DIHOR 3372",2500).payload.daily_budget).not.toThrow();
  expect(()=>montarConjuntoWhatsappPausado(origem,{id:"123"},
    "5511959643372","DIHOR 3372",null)).toThrow();
  expect(()=>montarConjuntoWhatsappPausado({...origem,campaign_id:"456"},
    {id:"123"},"5511959643372","DIHOR 3372",2500)).toThrow();
  expect(()=>montarConjuntoWhatsappPausado({...origem,destination_type:"WEBSITE"},
    {id:"123"},"5511959643372","DIHOR 3372",2500)).toThrow();
});

test("criação chama POST uma vez, em PAUSED, e confirma número no retorno Meta", async () => {
  let posts=0;
  const req=async(u:string, init?:RequestInit) => {
    if (u.includes("/123?fields")) return resposta({id:"123",account_id:"123456",daily_budget:"5000"});
    if (u.includes("/100?fields")) return resposta(origem);
    if (u.includes("/act_123456/adsets") && init?.method==="POST") {
      posts++;
      const body=new URLSearchParams(String(init.body));
      expect(body.get("status")).toBe("PAUSED");
      expect(body.get("daily_budget")).toBeNull();
      expect(JSON.parse(String(body.get("promoted_object"))).whatsapp_phone_number).toBe("5511980930205");
      return resposta({id:"789"});
    }
    if (u.includes("/789?fields")) return resposta({id:"789",status:"PAUSED",
      promoted_object:{whatsapp_phone_number:"5511980930205"}});
    return resposta({},404);
  };
  const result=await criarConjuntoWhatsappPausadoMeta({
    campanhaId:"123",contaAdsId:"act_123456",fonteId:"100",
    numeroWhatsapp:"5511980930205",nome:"DIHOR 0205",token:"token"
  },req);
  expect(posts).toBe(1);
  expect(result.anuncio_criado).toBe(false);
  expect(result.numero_verificado).toBe(true);
});

test("paginação da Meta não pode enviar token para outro domínio", async () => {
  const req=async (u:string)=>u.includes("/123/adsets")
      ? resposta({data:[],paging:{next:"https://attacker.example/steal"}})
      : resposta({id:"123",data:[]});
  await expect(listarConjuntosCampanhaMeta("123","token",req)).rejects.toThrow("Endereço de paginação");
});
