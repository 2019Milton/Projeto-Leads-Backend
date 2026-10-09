import {expect,test} from "bun:test";
import {prepararCriativoWhatsappCopia,verificarAnuncioOriginalWhatsapp} from "./meta-duplicacao-anuncio";

const base={
 object_story_spec:{page_id:"321",instagram_actor_id:"999",
  link_data:{
   image_hash:"hash-abc",message:"Oferta Suplementos",name:"Produto DHIOR",
   link:"https://api.whatsapp.com/send?phone=5521969099020&text=Oi",
   call_to_action:{type:"WHATSAPP_MESSAGE",value:{whatsapp_number:"5521969099020",link:"https://wa.me/5521969099020"}}
  }
 }
};
test("cópia altera todos links de destino do criativo e mantém texto, imagem e identidade",()=>{
 const origem=JSON.stringify(base);
 const copia=prepararCriativoWhatsappCopia(base,"321","5511980930205");
 expect(copia.object_story_spec.link_data.message).toBe("Oferta Suplementos");
 expect(copia.object_story_spec.link_data.image_hash).toBe("hash-abc");
 expect(copia.object_story_spec.instagram_actor_id).toBe("999");
 expect(JSON.stringify(copia)).not.toContain("5521969099020");
 expect(JSON.stringify(copia)).toContain("5511980930205");
 expect(JSON.stringify(base)).toBe(origem);
});
test("preserva vídeo, troca CTA e rejeita ausência de vídeo ID",()=>{
 const original={object_story_spec:{page_id:"321",video_data:{video_id:"666",
   message:"Vídeo original",call_to_action:{type:"WHATSAPP_MESSAGE",value:{whatsapp_number:"5521969099020"}}}}};
 const copia=prepararCriativoWhatsappCopia(original,"321","5511959643372");
 expect(copia.object_story_spec.video_data.video_id).toBe("666");
 expect(JSON.stringify(copia)).not.toContain("5521969099020");
 expect(()=>prepararCriativoWhatsappCopia(
   {object_story_spec:{page_id:"321",video_data:{message:"sem vídeo",call_to_action:{type:"WHATSAPP_MESSAGE"}}}},
   "321","5511959643372")).toThrow("vídeo");
});
test("video_data: Meta aceita uma só miniatura (hash tem precedência sobre URL)",()=>{
  const original={
    object_story_spec:{page_id:"321",instagram_actor_id:"999",video_data:{
      video_id:"666",message:"Texto DHIOR",title:"Oferta",
      image_hash:"hash-frame-video",image_url:"https://example.org/thumbnail.jpg",
      call_to_action:{type:"WHATSAPP_MESSAGE",
        value:{whatsapp_number:"5521969099020",link:"https://wa.me/5521969099020"}}
    }}
  };
  const snapshot=JSON.stringify(original);
  const copia=prepararCriativoWhatsappCopia(original,"321","5511959643372");
  const video=copia.object_story_spec.video_data;
  expect(video.video_id).toBe("666");
  expect(video.image_hash).toBe("hash-frame-video");
  expect(video.image_url).toBeUndefined();
  expect(video.message).toBe("Texto DHIOR");
  expect(video.call_to_action.value.whatsapp_number).toBe("5511959643372");
  expect(JSON.stringify(copia)).not.toContain("5521969099020");
  expect(JSON.stringify(original)).toBe(snapshot);
});
test("video_data preserva URL quando não há hash utilizável",()=>{
  const video=(image_hash?:string)=>({object_story_spec:{page_id:"321",video_data:{
    video_id:"666",message:"Vídeo",image_hash,image_url:"https://example.org/thumb.jpg",
    call_to_action:{type:"WHATSAPP_MESSAGE",value:{whatsapp_number:"5521969099020"}}
  }}});
  for(const original of [video(),video("")]){
    const copia=prepararCriativoWhatsappCopia(original,"321","5511959643372");
    expect(copia.object_story_spec.video_data.image_hash).toBeUndefined();
    expect(copia.object_story_spec.video_data.image_url).toBe("https://example.org/thumb.jpg");
  }
});
test("video_data sem miniatura não inventa imagem e preserva video_id",()=>{
  const original={object_story_spec:{page_id:"321",video_data:{
    video_id:"666",message:"Vídeo original",
    call_to_action:{type:"WHATSAPP_MESSAGE",value:{whatsapp_number:"5521969099020"}}
  }}};
  const copia=prepararCriativoWhatsappCopia(original,"321","5511959643372");
  expect(copia.object_story_spec.video_data.video_id).toBe("666");
  expect(copia.object_story_spec.video_data.image_url).toBeUndefined();
  expect(copia.object_story_spec.video_data.image_hash).toBeUndefined();
});
test("anúncio com publicação preexistente, carrossel e modelo dinâmico são bloqueados",()=>{
 expect(()=>prepararCriativoWhatsappCopia({object_story_id:"321_999"},"321","5511980930205")).toThrow();
 expect(()=>prepararCriativoWhatsappCopia({asset_feed_spec:{images:[]},...base},"321","5511980930205")).toThrow();
 expect(()=>prepararCriativoWhatsappCopia(
 {object_story_spec:{page_id:"321",link_data:{child_attachments:[{link:"https://wa.me/5521969099020"}]}}},
 "321","5511980930205")).toThrow();
});
test("preflight rejeita anúncio de outro conjunto ANTES de criar publicidade",async()=>{
 let consultas=0;
 const req=async()=>{consultas++;return new Response(JSON.stringify({
  id:"555",account_id:"123",campaign_id:"111",adset_id:"100",creative:{id:"666"}
 }),{status:200});};
 await expect(verificarAnuncioOriginalWhatsapp({
  campanhaId:"123",contaAdsId:"act_123",conjuntoOrigemId:"100",
  anuncioOrigemId:"555",paginaOrigem:"321",numeroDestino:"5511980930205",token:"mock"
 },req)).rejects.toThrow("não pertence");
 expect(consultas).toBe(1);
});
