import {test,expect} from "bun:test";
import {detalharErroMetaAdset} from "./meta-erros-diagnostico";
import {validarConjuntoWhatsappPausadoMeta} from "./meta-conjuntos-campanha";

const R=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});

test("erros Meta exibem descrição específica, subcódigo, campo e referência",()=>{
 const res=detalharErroMetaAdset({error:{
  code:100,error_subcode:1885024,
  message:"Invalid parameter",
  error_user_title:"WhatsApp not linked",
  error_user_msg:"This WhatsApp phone number is not linked to this account",
  error_data:{blame_field_specs:[["promoted_object","whatsapp_phone_number"]]},
  fbtrace_id:"AbCdEf012345"
 }},400);
 expect(res.codigo).toBe(100);
 expect(res.subcodigo).toBe(1885024);
 expect(res.campo).toBe("promoted_object.whatsapp_phone_number");
 expect(res.resumo).toContain("WhatsApp not linked");
 expect(res.resumo).toContain("AbCdEf012345");
});
test("não vaza token que apareça em mensagem da Meta",()=>{
 const res=detalharErroMetaAdset({error:{code:100,error_user_msg:
  "Bearer secret_abcdef123 access_token=NOT_PRINT_THIS",
  error_data:'{"blame_field":"targeting"}'
 }},400);
 expect(res.resumo).not.toContain("secret_abcdef123");
 expect(res.resumo).not.toContain("NOT_PRINT_THIS");
 expect(res.campo).toBe("targeting");
});
test("validação Meta de conjunto usa execution_options validate_only sem criar anúncio nem conjunto",async()=>{
 let chamadasCriacaoSemValidacao=0,postValidacao=0;
 const req=async(u:string,init?:RequestInit)=>{
  if(u.includes("/123?fields="))return R({id:"123",account_id:"123456",daily_budget:"0"});
  if(u.includes("/100?fields="))return R({
   id:"100",campaign_id:"123",destination_type:"WHATSAPP",
   promoted_object:{page_id:"321",whatsapp_phone_number:"5521969099020"},
   targeting:{geo_locations:{countries:["BR"]}},
   billing_event:"IMPRESSIONS",optimization_goal:"CONVERSATIONS"
  });
  if(u.includes("/555?fields="))return R({
   id:"555",account_id:"123456",campaign_id:"123",adset_id:"100",
   name:"DIHOR",creative:{id:"666"}
  });
  if(u.includes("/666?fields="))return R({id:"666",object_story_spec:{
   page_id:"321",link_data:{message:"Suplementos",image_hash:"abc",
    call_to_action:{type:"WHATSAPP_MESSAGE",value:{whatsapp_number:"5521969099020"}}}}});
  if(u.includes("/act_123456/adsets")&&init?.method==="POST") {
   const body=new URLSearchParams(String(init.body));
   expect(JSON.parse(String(body.get("execution_options")))).toEqual(["validate_only"]);
   expect(body.get("status")).toBe("PAUSED");
   expect(JSON.parse(String(body.get("promoted_object"))).whatsapp_phone_number).toBe("5511959643372");
   postValidacao++;
   return R({success:true});
  }
  if(init?.method==="POST")chamadasCriacaoSemValidacao++;
  return R({error:{code:404}},404);
 };
 const r=await validarConjuntoWhatsappPausadoMeta({
  campanhaId:"123",contaAdsId:"act_123456",fonteId:"100",
  anuncioOrigemId:"555",numeroWhatsapp:"5511959643372",
  nome:"DIHOR Whatsapp 3372",orcamentoDiarioCentavos:3500,token:"mock"
 },req);
 expect(r.ok).toBe(true);
 expect(r.validacao_sem_criacao).toBe(true);
 expect(chamadasCriacaoSemValidacao).toBe(0);
 expect(postValidacao).toBe(1);
});
test("Meta rejeita validação sem criar conjunto e informa o motivo real",async()=>{
 let writes=0;
 const req=async(u:string,init?:RequestInit)=>{
  if(u.includes("/123?fields="))return R({id:"123",account_id:"123456"});
  if(u.includes("/100?fields="))return R({
   id:"100",campaign_id:"123",destination_type:"WHATSAPP",
   promoted_object:{page_id:"321"},targeting:{geo_locations:{countries:["BR"]}},
   optimization_goal:"CONVERSATIONS",billing_event:"IMPRESSIONS"
  });
  if(u.includes("/555?fields="))return R({id:"555",campaign_id:"123",adset_id:"100",
   account_id:"123456",creative:{id:"666"},name:"Anúncio DIHOR"});
  if(u.includes("/666?fields="))return R({
   object_story_spec:{page_id:"321",link_data:{image_hash:"abc",
   call_to_action:{type:"WHATSAPP_MESSAGE",value:{whatsapp_number:"5521969099020"}}}}
  });
  if(u.includes("/act_123456/adsets")&&init?.method==="POST"){
   writes++;
   const body=new URLSearchParams(String(init.body));
   expect(body.get("execution_options")).toBe('["validate_only"]');
   return R({error:{code:100,error_subcode:1487756,
     error_user_title:"Público inválido",
     error_user_msg:"Uma localização selecionada não é permitida",
     error_data:{blame_field:"targeting"}}},400);
  }
  return R({},404);
 };
 await expect(validarConjuntoWhatsappPausadoMeta({
  campanhaId:"123",contaAdsId:"act_123456",fonteId:"100",
  anuncioOrigemId:"555",numeroWhatsapp:"5511959643372",
  nome:"DIHOR Whatsapp 3372",orcamentoDiarioCentavos:3500,token:"mock"
 },req)).rejects.toThrow("Uma localização");
 expect(writes).toBe(1);
});
