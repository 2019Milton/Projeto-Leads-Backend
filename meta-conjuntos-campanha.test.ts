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

test("CONVERSATIONS usa atribuição de clique em 1 dia em vez da configuração herdada de 7 dias", () => {
  const fonte = {
    ...origem,
    attribution_spec: [
      {event_type:"CLICK_THROUGH",window_days:7},
      {event_type:"VIEW_THROUGH",window_days:1}
    ]
  };
  const r=montarConjuntoWhatsappPausado(fonte,{id:"123"},
    "5511959643372","DHIOR 3372",3500);
  expect(r.payload.attribution_spec).toEqual([
    {event_type:"CLICK_THROUGH",window_days:1}
  ]);
  expect(r.payload.optimization_goal).toBe("CONVERSATIONS");
  expect(r.payload.status).toBe("PAUSED");
  expect(r.payload.daily_budget).toBe(3500);
  expect(fonte.attribution_spec[0].window_days).toBe(7);
});
test("CONVERSATIONS usa janela de 1 dia quando adset original não informa atribuição",()=>{
  const r=montarConjuntoWhatsappPausado(origem,{id:"123"},
    "5511980930205","DHIOR 0205",3500);
  expect(r.payload.attribution_spec).toEqual([
    {event_type:"CLICK_THROUGH",window_days:1}
  ]);
});
test("não altera atribuição de outros objetivos diferentes de CONVERSATIONS",()=>{
  const fonte = {...origem,optimization_goal:"LINK_CLICKS",
    attribution_spec:[{event_type:"CLICK_THROUGH",window_days:7}]};
  const r=montarConjuntoWhatsappPausado(fonte,{id:"123"},
    "5511980930205","DIHOR 0205",3500);
  expect(r.payload.attribution_spec).toEqual(fonte.attribution_spec);
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

test("criação duplica conjunto e anúncio mantendo ambos PAUSADOS e substituindo o WhatsApp", async () => {
  const posts: string[] = [];
  const req=async(u:string, init?:RequestInit) => {
    if (u.includes("/123?fields")) return resposta({id:"123",account_id:"123456",daily_budget:"5000"});
    if (u.includes("/100?fields")) return resposta(origem);
    if (u.includes("/555?fields")) return resposta({
      id:"555",campaign_id:"123",adset_id:"100",account_id:"123456",
      name:"Anúncio DIHOR",creative:{id:"666"}
    });
    if (u.includes("/666?fields")) return resposta({
      id:"666",object_story_spec:{page_id:"321",
        link_data:{message:"Imagem do original",image_hash:"abc",link:"https://wa.me/5521969099020",
          call_to_action:{type:"WHATSAPP_MESSAGE",value:{whatsapp_number:"5521969099020"}}}}
    });
    if (u.includes("/act_123456/adsets") && init?.method==="POST") {
      const body=new URLSearchParams(String(init.body));
      expect(body.get("status")).toBe("PAUSED");
      expect(JSON.parse(String(body.get("attribution_spec")))).toEqual([
        {event_type:"CLICK_THROUGH",window_days:1}
      ]);
      expect(body.get("daily_budget")).toBeNull();
      expect(JSON.parse(String(body.get("promoted_object"))).whatsapp_phone_number).toBe("5511980930205");
      posts.push("adset");
      return resposta({id:"789"});
    }
    if (u.includes("/789?fields")) return resposta({id:"789",campaign_id:"123",
      status:"PAUSED",destination_type:"WHATSAPP",
      promoted_object:{whatsapp_phone_number:"5511980930205"}});
    if (u.includes("/act_123456/ads") && init?.method==="POST") {
      const body=new URLSearchParams(String(init.body));
      const creative=JSON.parse(String(body.get("creative")));
      expect(body.get("status")).toBe("PAUSED");
      expect(body.get("adset_id")).toBe("789");
      expect(JSON.stringify(creative)).not.toContain("5521969099020");
      expect(JSON.stringify(creative)).toContain("5511980930205");
      expect(creative.object_story_spec.link_data.message).toBe("Imagem do original");
      posts.push("ad");
      return resposta({id:"890"});
    }
    if (u.includes("/890?fields")) return resposta({id:"890",status:"PAUSED",adset_id:"789",creative:{id:"891"}});
    if (u.includes("/891?fields")) return resposta({id:"891",object_story_spec:{link_data:{
      call_to_action:{type:"WHATSAPP_MESSAGE",value:{whatsapp_number:"5511980930205"}}}}});
    return resposta({},404);
  };
  const result=await criarConjuntoWhatsappPausadoMeta({
    campanhaId:"123",contaAdsId:"act_123456",fonteId:"100",anuncioOrigemId:"555",
    numeroWhatsapp:"5511980930205",nome:"DIHOR 0205",token:"token"
  },req);
  expect(posts).toEqual(["adset","ad"]);
  expect(result.parcial).toBe(false);
  expect(result.anuncio_criado).toBe(true);
  expect(result.anuncio_id).toBe("890");
  expect(result.numero_verificado).toBe(true);
});

test("falha na cópia mantém novo conjunto pausado sem anúncio e avisa criação parcial", async () => {
  const req=async(u:string,init?:RequestInit) => {
    if (u.includes("/123?fields")) return resposta({id:"123",account_id:"123456",daily_budget:"5000"});
    if (u.includes("/100?fields")) return resposta(origem);
    if (u.includes("/555?fields")) return resposta({id:"555",campaign_id:"123",adset_id:"100",
      account_id:"123456",name:"Anúncio DIHOR",creative:{id:"666"}});
    if (u.includes("/666?fields")) return resposta({object_story_spec:{page_id:"321",
      link_data:{image_hash:"abc",call_to_action:{type:"WHATSAPP_MESSAGE",value:{}}}}});
    if (u.includes("/act_123456/adsets")&&init?.method==="POST") return resposta({id:"789"});
    if (u.includes("/789?fields")) return resposta({id:"789",campaign_id:"123",
      status:"PAUSED",destination_type:"WHATSAPP",
      promoted_object:{whatsapp_phone_number:"5511980930205"}});
    if (u.includes("/act_123456/ads")&&init?.method==="POST")
      return resposta({error:{code:100}},400);
    return resposta({},404);
  };
  const result=await criarConjuntoWhatsappPausadoMeta({
    campanhaId:"123",contaAdsId:"act_123456",fonteId:"100",anuncioOrigemId:"555",
    numeroWhatsapp:"5511980930205",nome:"DIHOR 0205",token:"token"
  },req);
  expect(result.parcial).toBe(true);
  expect(result.anuncio_criado).toBe(false);
  expect(result.status).toBe("PAUSED");
});

test("paginação da Meta não pode enviar token para outro domínio", async () => {
  const req=async (u:string)=>u.includes("/123/adsets")
      ? resposta({data:[],paging:{next:"https://attacker.example/steal"}})
      : resposta({id:"123",data:[]});
  await expect(listarConjuntosCampanhaMeta("123","token",req)).rejects.toThrow("Endereço de paginação");
});
