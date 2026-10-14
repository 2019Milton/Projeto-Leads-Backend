import {test,expect} from "bun:test";
import {intervaloDistribuicao,mapearConjuntosMeta,agregarDistribuicao} from "./meta-distribuicao-leads";

const conjuntos=[
 {id:"600",nome:"DHIOR 9020",status:"ACTIVE",numero:"5521969099020",
  anuncio_ids:["700"],orcamento_centavos:3500,gasto_reais:12.50},
 {id:"666",nome:"DHIOR 3372",status:"ACTIVE",numero:"5511959643372",
  anuncio_ids:["777"],orcamento_centavos:3500,gasto_reais:15.50}
];
const numeros=[
 {phone_number_id:"N9020",numero:"+55 21 96909-9020",display_name:"Marcos"},
 {phone_number_id:"N3372",numero:"+55 11 95964-3372",display_name:"Nahã"},
 {phone_number_id:"N0205",numero:"+55 11 98093-0205",display_name:"DIHOR"}
];
test("janelas de período usam datas de São Paulo e último dia inclusivo",()=>{
 expect(intervaloDistribuicao("hoje",undefined,undefined,"2026-10-14"))
  .toMatchObject({inicio:"2026-10-14",fim:"2026-10-14"});
 expect(intervaloDistribuicao("ontem",undefined,undefined,"2026-10-14"))
  .toMatchObject({inicio:"2026-10-13",fim:"2026-10-13"});
 expect(intervaloDistribuicao("7d",undefined,undefined,"2026-10-14"))
  .toMatchObject({inicio:"2026-10-08",fim:"2026-10-14"});
 expect(intervaloDistribuicao("30d",undefined,undefined,"2026-10-14"))
  .toMatchObject({inicio:"2026-09-15",fim:"2026-10-14"});
});
test("custom exige datas existentes, até 90 dias e sem futuro",()=>{
 expect(intervaloDistribuicao("personalizado","2026-10-01","2026-10-14","2026-10-14").inicio).toBe("2026-10-01");
 for(const par of [
  ["2026-02-30","2026-03-02"],["2026-10-15","2026-10-17"],
  ["2026-01-01","2026-10-14"],["2026-10-14","2026-10-01"]
 ]){
  expect(()=>intervaloDistribuicao("personalizado",par[0],par[1],"2026-10-14")).toThrow();
 }
});
test("cruzamento Meta preserva orçamento e gasto real do período, não inventa sem insights",()=>{
 const retorno=mapearConjuntosMeta({data:[
  {id:"600",name:"9020",status:"ACTIVE",daily_budget:"3500",
   promoted_object:{whatsapp_phone_number:"5521969099020"},
   ads:{data:[{id:"700"}]},insights:{data:[{spend:"12.5"}]}},
  {id:"666",name:"3372",status:"PAUSED",daily_budget:"3500",
   promoted_object:{whatsapp_phone_number:"5511959643372"},
   ads:{data:[{id:"777"}]}}
 ]});
 expect(retorno.map(x=>x.gasto_reais)).toEqual([12.5,null]);
 expect(retorno.map(x=>x.orcamento_centavos)).toEqual([3500,3500]);
});
test("paginação incompleta recusa métricas para não omitir conjuntos ou anúncios",()=>{
 expect(()=>mapearConjuntosMeta({data:[],paging:{next:"https://graph.facebook.com/.."}})).toThrow();
 expect(()=>mapearConjuntosMeta({data:[{id:"600",ads:{data:[],paging:{next:"..."}}}]})).toThrow();
});
test("por 9020 e 3372: conta leads únicos e atribui exclusivamente ao source_id do anúncio",()=>{
 const rows=[
  {lead_id:1,campanha_id:42,phone_number_id:"N9020",source_id:"700",source_type:"ad"},
  {lead_id:1,campanha_id:42,phone_number_id:"N9020",source_id:"700",source_type:"ad"},
  {lead_id:2,campanha_id:42,phone_number_id:"N3372",source_id:"777",source_type:"ad"},
  {lead_id:3,campanha_id:42,phone_number_id:"N3372",source_id:null,source_type:null},
  {lead_id:4,campanha_id:99,phone_number_id:"N3372",source_id:"other",source_type:"ad"},
  {lead_id:5,campanha_id:42,phone_number_id:"N0205",source_id:null,source_type:null},
  {lead_id:6,campanha_id:null,phone_number_id:"N9020",source_id:"700",source_type:"ad"}
 ];
 const r=agregarDistribuicao(rows,conjuntos,numeros,42);
 expect(r.total_leads).toBe(5);
 expect(r.leads_atribuidos).toBe(3);
 expect(r.sem_conjunto).toBe(2);
 expect(r.conjuntos.map(x=>x.leads)).toEqual([2,1]);
 expect(r.numeros.find(x=>x.numero==="5521969099020")?.leads).toBe(2);
 expect(r.numeros.find(x=>x.numero==="5511959643372")?.leads).toBe(2);
 expect(r.numeros.find(x=>x.numero==="5511980930205")?.leads).toBe(1);
 expect(r.conjuntos[0].custo_por_lead).toBe(6.25);
 expect(r.conjuntos[1].custo_por_lead).toBe(15.5);
});
test("não mistura leads de outra campanha ou número; sem dados mostra 0 e CPL indisponível",()=>{
 const rows=[
  {lead_id:1,campanha_id:123,phone_number_id:"N9020",source_id:"outra",source_type:"ad"},
  {lead_id:2,campanha_id:42,phone_number_id:"OUTRO_USUARIO",source_id:"700",source_type:"ad"}
 ];
 const r=agregarDistribuicao(rows,conjuntos,numeros,42);
 expect(r.total_leads).toBe(0);
 expect(r.conjuntos.map(x=>x.leads)).toEqual([0,0]);
 expect(r.conjuntos.every(x=>x.custo_por_lead===null)).toBe(true);
});
