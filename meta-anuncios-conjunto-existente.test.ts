import {test,expect} from "bun:test";
import {validarCopiaAnuncioEmConjuntoExistente,copiarAnuncioEmConjuntoExistente}
from "./meta-anuncios-conjunto-existente";

const p={
 campanhaId:"123",contaAdsId:"act_456",conjuntoDestinoId:"120251090441980696",
 conjuntoOrigemId:"100",anuncioOrigemId:"555",numeroWhatsapp:"5511959643372",
 token:"fake-token"
};
const resposta=(obj:any,status=200)=>new Response(JSON.stringify(obj),{status});
function simularMeta(opcoes:{destinoTemAnuncio?:boolean;recusarCopia?:boolean;destinoAtivo?:boolean}={}){
 let writes:{path:string,params:URLSearchParams}[]=[];
 let consultas:string[]=[];
 const req=async(url:string,init?:RequestInit)=>{
  const path=new URL(url).pathname;
  consultas.push((init?.method||"GET")+" "+path);
  if(path.endsWith("/"+p.conjuntoDestinoId))return resposta({
   id:p.conjuntoDestinoId,campaign_id:"123",account_id:"456",
   status:opcoes.destinoAtivo?"ACTIVE":"PAUSED",destination_type:"WHATSAPP",
   promoted_object:{page_id:"321",whatsapp_phone_number:"5511959643372"}
  });
  if(path.endsWith("/100"))return resposta({
    id:"100",campaign_id:"123",account_id:"456",
    promoted_object:{page_id:"321",whatsapp_phone_number:"5521969099020"}
  });
  if(path.endsWith("/"+p.conjuntoDestinoId+"/ads")){
    return resposta({data:opcoes.destinoTemAnuncio?[{id:"333",name:"Existente"}]:[]});
  }
  if(path.endsWith("/555"))return resposta({
    id:"555",name:"DHIOR original",campaign_id:"123",adset_id:"100",
    account_id:"456",creative:{id:"666"}
  });
  if(path.endsWith("/666"))return resposta({
    id:"666",object_story_spec:{
      page_id:"321",link_data:{image_hash:"imagem123",message:"Imagem original",
      link:"https://wa.me/5521969099020",
      call_to_action:{type:"WHATSAPP_MESSAGE",value:{whatsapp_number:"5521969099020"}}}
    }
  });
  if(path.endsWith("/act_456/ads") && init?.method==="POST"){
    const body=new URLSearchParams(String(init.body));
    writes.push({path,params:body});
    expect(body.get("adset_id")).toBe(p.conjuntoDestinoId);
    expect(body.get("status")).toBe("PAUSED");
    expect(JSON.stringify(JSON.parse(body.get("creative")!))).not.toContain("5521969099020");
    if(opcoes.recusarCopia)return resposta({error:{
      code:100,error_subcode:1443041,error_user_title:"Criativo inválido",
      error_user_msg:"Call to action não permitido",error_data:{blame_field:"creative"}
    }},400);
    if(body.get("execution_options"))return resposta({success:true});
    return resposta({id:"777"});
  }
  if(path.endsWith("/777"))return resposta({
    id:"777",status:"PAUSED",adset_id:p.conjuntoDestinoId,creative:{id:"888"}
  });
  if(path.endsWith("/888"))return resposta({
    id:"888",object_story_spec:{page_id:"321",link_data:{
      call_to_action:{type:"WHATSAPP_MESSAGE",value:{whatsapp_number:"5511959643372"}}
    }}
  });
  throw new Error("Consulta inesperada: "+path);
 };
 return {req,writes,consultas};
}
test("valida cópia ao conjunto existente SEM criar nenhum anúncio",async()=>{
 const m=simularMeta();
 const r=await validarCopiaAnuncioEmConjuntoExistente(p,m.req);
 expect(r.ok).toBe(true);
 expect(r.validacao_sem_criacao).toBe(true);
 expect(r.conjunto_id).toBe(p.conjuntoDestinoId);
 expect(m.writes).toHaveLength(1);
 expect(JSON.parse(String(m.writes[0].params.get("execution_options")))).toEqual(["validate_only"]);
});
test("copia anúncio PAUSADO no conjunto existente, não cria outro conjunto",async()=>{
 const m=simularMeta();
 const r=await copiarAnuncioEmConjuntoExistente(p,m.req);
 expect(r).toMatchObject({
   ok:true,parcial:false,anuncio_id:"777",conjunto_id:p.conjuntoDestinoId,
   status:"PAUSED",numero_criativo_confirmado:true
 });
 expect(m.writes).toHaveLength(2);
 expect(m.writes[0].params.has("execution_options")).toBe(true);
 expect(m.writes[1].params.has("execution_options")).toBe(false);
 expect(m.writes.every(x=>x.path.endsWith("/ads"))).toBe(true);
 expect(m.consultas.filter(x=>x.endsWith("/"+p.conjuntoDestinoId+"/ads")).length).toBe(2);
});
test("rejeita conjunto já com anúncio, sem qualquer POST",async()=>{
 const m=simularMeta({destinoTemAnuncio:true});
 await expect(copiarAnuncioEmConjuntoExistente(p,m.req)).rejects.toThrow("já possui anúncio");
 expect(m.writes).toHaveLength(0);
});
test("rejeita conjunto ATIVO antes de qualquer cópia",async()=>{
 const m=simularMeta({destinoAtivo:true});
 await expect(validarCopiaAnuncioEmConjuntoExistente(p,m.req)).rejects.toThrow("PAUSADO");
 expect(m.writes).toHaveLength(0);
});
test("recusa da Meta preserva motivo com subcódigo e campo rejeitado",async()=>{
 const m=simularMeta({recusarCopia:true});
 await expect(validarCopiaAnuncioEmConjuntoExistente(p,m.req)).rejects.toThrow("Call to action não permitido");
 expect(m.writes).toHaveLength(1);
});
test("não permite adset da mesma origem, ou WhatsApp divergente",async()=>{
 const m=simularMeta();
 await expect(validarCopiaAnuncioEmConjuntoExistente({...p,conjuntoDestinoId:"100"},m.req)).rejects.toThrow("diferentes");
 await expect(validarCopiaAnuncioEmConjuntoExistente({...p,numeroWhatsapp:"5511980930205"},m.req)).rejects.toThrow("WhatsApp");
 expect(m.writes).toHaveLength(0);
});
