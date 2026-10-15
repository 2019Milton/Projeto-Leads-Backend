import {test,expect} from "bun:test";
import {listarConjuntosCampanhaMeta} from "./meta-conjuntos-campanha";
const resp=(obj:any,status=200)=>new Response(JSON.stringify(obj),{
 status,headers:{"content-type":"application/json"}
});
function metaSimulada(falharInsights=false){
 const urls:string[]=[];
 const req=async(url:string,opts?:RequestInit)=>{
  urls.push((opts?.method||"GET")+" "+url);
  if(url.includes("/123/adsets"))return resp({data:[
    {id:"9020",name:"9020",status:"ACTIVE",promoted_object:{whatsapp_phone_number:"5521969099020"},daily_budget:"3500"},
    {id:"3372",name:"3372",status:"ACTIVE",promoted_object:{whatsapp_phone_number:"5511959643372"},daily_budget:"3500"}
  ]});
  if(url.includes("/123/ads"))return resp({data:[
    {id:"700",adset_id:"9020",status:"ACTIVE",name:"Anúncio 9020"},
    {id:"777",adset_id:"3372",status:"ACTIVE",name:"Anúncio 3372"}
  ]});
  if(url.includes("/123/insights")){
    if(falharInsights)return resp({error:{code:613}},400);
    const hoje=url.includes("date_preset=today");
    return resp({data:[
      {adset_id:"9020",spend:hoje?"0.00":"85.14",impressions:hoje?"0":"3000",
        clicks:hoje?"0":"230",ctr:hoje?"0":"2",actions:hoje?[]:
          [{action_type:"onsite_conversion.messaging_conversation_started",value:"15"}]},
      {adset_id:"3372",spend:hoje?"4.50":"10.03",impressions:hoje?"200":"581",
        clicks:hoje?"9":"25",ctr:hoje?"4.5":"4.3",
        actions:[{action_type:"onsite_conversion.messaging_conversation_started",value:hoje?"2":"7"}]}
    ]});
  }
  if(url.includes("/123?fields"))return resp({id:"123",name:"DIHOR",objective:"OUTCOME_ENGAGEMENT",status:"ACTIVE"});
  return resp({},404);
 };
 return {req,urls};
}
test("padrão conserva os 30 dias e não envia comandos Meta",async()=>{
 const s=metaSimulada();
 const d=await listarConjuntosCampanhaMeta("123","fake",s.req);
 expect(d.periodo_query).toBe("30d");
 expect(d.periodo_metricas).toContain("30 dias");
 expect(d.conjuntos[0].metricas.cliques).toBe(230);
 expect(d.conjuntos[1].metricas.conversas_meta).toBe(7);
 expect(s.urls.some(u=>u.includes("date_preset=last_30d"))).toBe(true);
 expect(s.urls.every(u=>u.startsWith("GET "))).toBe(true);
});
test("Hoje consulta insights today individualmente por conjunto",async()=>{
 const s=metaSimulada();
 const d=await listarConjuntosCampanhaMeta("123","fake",s.req,"hoje");
 expect(d.periodo_query).toBe("hoje");
 expect(d.periodo_metricas).toContain("Hoje");
 expect(d.conjuntos[0].metricas).toMatchObject({gasto:0,cliques:0,impressoes:0});
 expect(d.conjuntos[1].metricas).toMatchObject({
  gasto:4.5,cliques:9,impressoes:200,conversas_meta:2
 });
 expect(s.urls.some(u=>u.includes("date_preset=today"))).toBe(true);
 expect(s.urls.every(u=>u.startsWith("GET "))).toBe(true);
});
test("Erro Meta não é apresentado como zero confirmado",async()=>{
 const s=metaSimulada(true);
 const d=await listarConjuntosCampanhaMeta("123","fake",s.req,"hoje");
 expect(d.aviso_metricas).toBeTruthy();
 expect(d.conjuntos[0].metricas.gasto).toBeNull();
 expect(d.conjuntos[1].metricas.cliques).toBeNull();
 expect(d.conjuntos[1].metricas.conversas_meta).toBeNull();
});
test("Períodos inválidos não fazem qualquer chamada",async()=>{
 const s=metaSimulada();
 await expect(listarConjuntosCampanhaMeta("123","fake",s.req,"ontem" as any))
   .rejects.toThrow("inválido");
 expect(s.urls).toHaveLength(0);
});
