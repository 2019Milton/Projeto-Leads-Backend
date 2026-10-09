import {test,expect} from "bun:test";
import {validarDistribuicaoConjuntos,repartirIgualmenteCentavos,distribuirOrcamentosMeta} from "./meta-orcamentos-conjuntos";
const item=(id:string,valor:number,esperado:number=1000,status="ACTIVE")=>({
  id,centavos:valor,esperado_centavos:esperado,esperado_status:status
});
const R=(json:any,status=200)=>new Response(JSON.stringify(json),{status});

test("total deve bater centavo a centavo sem IDs repetidos e mínimo de orçamento",()=>{
 expect(()=>validarDistribuicaoConjuntos([item("1",3500,7000),item("2",3500,0,"PAUSED")],7000)).not.toThrow();
 expect(()=>validarDistribuicaoConjuntos([item("1",3500),item("1",3500)],7000)).toThrow("repetido");
 expect(()=>validarDistribuicaoConjuntos([item("1",3500)],7001)).toThrow("soma");
 expect(()=>validarDistribuicaoConjuntos([item("1",1499)],1499)).toThrow();
});
test("divisão igual mantém centavos sem perda",()=>{
 expect(repartirIgualmenteCentavos(7000,3)).toEqual([2334,2333,2333]);
 expect(repartirIgualmenteCentavos(7001,2)).toEqual([3501,3500]);
});
test("ABO atualiza somente conjuntos escolhidos, verifica orçamento e mantém status",async()=>{
 const calls:any[]=[];const current:{[id:string]:number}={"101":7000,"102":2500};
 const req=async(u:string,init?:RequestInit)=>{
  if(u.includes("/555?"))return R({id:"555",account_id:"123",daily_budget:null,lifetime_budget:null});
  for(const id of ["101","102"]){
   if(u.includes("/"+id+"?"))return R({id,account_id:"123",campaign_id:"555",daily_budget:String(current[id]),status:id==="101"?"ACTIVE":"PAUSED"});
   if(u.endsWith("/"+id)&&init?.method==="POST"){
    const b=new URLSearchParams(String(init.body));
    expect(b.has("status")).toBe(false);
    current[id]=Number(b.get("daily_budget"));calls.push(id);
    return R({success:true});
   }
  }
  return R({error:{code:100}},400);
 };
 const r=await distribuirOrcamentosMeta({campanhaId:"555",contaAdsId:"act_123",token:"mock",
  totalCentavos:7000,itens:[item("101",3500,7000),item("102",3500,2500,"PAUSED")]},req);
 expect(r.ok).toBe(true);
 expect(calls).toEqual(["101","102"]);
 expect(current).toEqual({"101":3500,"102":3500});
});
test("não altera campanha CBO ou conjunto cujo orçamento mudou desde carregamento",async()=>{
 let posts=0;
 const req=async(u:string,init?:RequestInit)=>{
   if(init?.method==="POST")posts++;
   if(u.includes("/555?"))return R({id:"555",account_id:"123",daily_budget:"7000"});
   return R({id:"101",account_id:"123",campaign_id:"555",daily_budget:"7000",status:"ACTIVE"});
 };
 await expect(distribuirOrcamentosMeta({campanhaId:"555",contaAdsId:"act_123",token:"mock",
  totalCentavos:3500,itens:[item("101",3500,7000)]},req)).rejects.toThrow("CBO");
 expect(posts).toBe(0);
});
test("falha na segunda edição tenta restaurar primeira; relata erro",async()=>{
 let posts=0;
 const current:{[id:string]:number}={"101":7000,"102":3500};
 const req=async(u:string,init?:RequestInit)=>{
  if(u.includes("/555?"))return R({id:"555",account_id:"123"});
  for(const id of ["101","102"]) {
    if(u.includes("/"+id+"?"))return R({id,account_id:"123",campaign_id:"555",daily_budget:current[id],status:"ACTIVE"});
    if(u.endsWith("/"+id)&&init?.method==="POST"){
      posts++;
      if(id==="102")return R({error:{code:100}},400);
      current[id]=Number(new URLSearchParams(String(init.body)).get("daily_budget"));
      return R({success:true});
    }
  }
  return R({},404);
 };
 const result=await distribuirOrcamentosMeta({campanhaId:"555",contaAdsId:"act_123",token:"mock",
  totalCentavos:7000,itens:[item("101",4000,7000),item("102",3000,3500)]},req);
 expect(result.ok).toBe(false);
 expect(current["101"]).toBe(7000);
 expect(posts).toBe(3);
});
