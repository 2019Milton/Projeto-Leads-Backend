/**
 * Cópia segura de criativos para anúncios Click-to-WhatsApp.
 * Nunca reutiliza o ID do criativo antigo: ele poderia conter o número de destino original.
 */
import {detalharErroMetaAdset} from "./meta-erros-diagnostico";
type Objeto = Record<string, any>;
type Req = (url: string, init?: RequestInit) => Promise<Response>;
const BASE = "https://graph.facebook.com/v25.0/";
const obj = (v: unknown): Objeto => v && typeof v === "object" && !Array.isArray(v) ? v as Objeto : {};
const digitos = (v: unknown): string => String(v || "").replace(/\D/g, "");
const idOk = (v: unknown) => /^\d+$/.test(String(v || ""));
const props = (source: Objeto, keys: string[]) => Object.fromEntries(
  keys.filter(k => source[k] !== null && source[k] !== undefined).map(k => [k,source[k]])
);

export async function consultarMetaDuplicacao(id: string, fields: string, token: string, req: Req=fetch) {
  if(!idOk(id)) throw new Error("Identificador Meta inválido");
  const url=BASE + id + "?fields=" + encodeURIComponent(fields);
  const r=await req(url,{headers:{Authorization:"Bearer "+token}});
  const dados=await r.json().catch(()=>({}));
  if(!r.ok || dados.error) {
    throw new Error("Meta recusou acesso ao anúncio original (código "+(dados?.error?.code||r.status)+")");
  }
  return obj(dados);
}

function trocarLinkWhatsApp(urlOriginal: unknown, novoNumero: string): unknown {
  if (typeof urlOriginal !== "string" || !urlOriginal) return urlOriginal;
  let url: URL;
  try { url=new URL(urlOriginal); } catch { return urlOriginal; }
  if(!["wa.me","api.whatsapp.com","web.whatsapp.com"].includes(url.hostname.toLowerCase()))
    return urlOriginal;
  if(url.hostname.toLowerCase()==="wa.me") {
    url.pathname="/"+novoNumero;
  } else {
    url.searchParams.set("phone",novoNumero);
  }
  return url.toString();
}

export function prepararCriativoWhatsappCopia(
  fonte: Objeto, paginaOrigem: string, numeroDestino: string
): Objeto {
  if(!/^55\d{10,11}$/.test(numeroDestino)) throw new Error("WhatsApp inválido para o anúncio copiado");
  if(fonte.asset_feed_spec || fonte.template_url_spec) {
    throw new Error("Criativo dinâmico não pode ser copiado automaticamente. Use o Gerenciador da Meta.");
  }
  const story=obj(fonte.object_story_spec);
  if(!idOk(story.page_id) || String(story.page_id)!==String(paginaOrigem)) {
    throw new Error("O criativo original não informa a mesma Página do conjunto.");
  }
  const chave = ["link_data","video_data"].find(k=>Object.keys(obj(story[k])).length>0);
  if(!chave) {
    throw new Error("Este anúncio usa um formato ou publicação existente que exige cópia manual na Meta.");
  }
  const base=obj(story[chave]);
  if(Array.isArray(base.child_attachments) && base.child_attachments.length) {
    throw new Error("Anúncio em carrossel: cópia automática ainda não suportada.");
  }
  const permitidos = chave === "link_data"
    ? ["message","name","description","caption","link","image_hash","picture","attachment_style","multi_share_end_card","multi_share_optimized"]
    : ["message","title","video_id","image_url","image_hash","link_description"];
  const conteudo=props(base,permitidos);
  if(chave==="video_data" && !conteudo.video_id)
    throw new Error("O vídeo original não retornou seu ID para cópia segura.");
  if(chave==="link_data" && !conteudo.image_hash && !conteudo.picture)
    throw new Error("A imagem original não retornou uma referência válida para a cópia.");
  const cta=obj(base.call_to_action);
  if(!String(cta.type||"").trim())
    throw new Error("O criativo não informou o botão do anúncio. Cópia manual necessária.");
  const valor=props(obj(cta.value),["app_destination","link","whatsapp_number"]);
  if(valor.link) valor.link=trocarLinkWhatsApp(valor.link,numeroDestino);
  valor.whatsapp_number=numeroDestino;
  conteudo.call_to_action={type:String(cta.type),value:valor};
  if(conteudo.link) conteudo.link=trocarLinkWhatsApp(conteudo.link,numeroDestino);
  const output:Objeto={
    page_id:String(story.page_id),
    [chave]:conteudo
  };
  if(idOk(story.instagram_actor_id)) output.instagram_actor_id=String(story.instagram_actor_id);
  const serial=JSON.stringify(output);
  if(/(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)55\d{10,11}/.test(serial) &&
     !serial.includes(numeroDestino)) {
    throw new Error("Não foi possível substituir com segurança o WhatsApp do criativo.");
  }
  return {object_story_spec:output};
}

export async function verificarAnuncioOriginalWhatsapp(
  params:{campanhaId:string,contaAdsId:string,conjuntoOrigemId:string,anuncioOrigemId:string,
    paginaOrigem:string,numeroDestino:string,token:string},
  req:Req=fetch
) {
  const {campanhaId,contaAdsId,conjuntoOrigemId,anuncioOrigemId,paginaOrigem,numeroDestino,token}=params;
  if(![campanhaId,conjuntoOrigemId,anuncioOrigemId].every(idOk))
    throw new Error("Identificadores de anúncio inválidos");
  const anuncio=await consultarMetaDuplicacao(anuncioOrigemId,
    "id,name,campaign_id,adset_id,account_id,creative{id}",token,req);
  if(String(anuncio.campaign_id)!==campanhaId ||
     String(anuncio.adset_id)!==conjuntoOrigemId ||
     String(anuncio.account_id).replace(/^act_/,"")!==contaAdsId.replace(/^act_/,"")) {
    throw new Error("O anúncio escolhido não pertence a este conjunto e conta Meta.");
  }
  const creativeId=String(obj(anuncio.creative).id || "");
  if(!idOk(creativeId)) throw new Error("A Meta não retornou o criativo original.");
  const criativo=await consultarMetaDuplicacao(creativeId,
    "id,object_story_spec,object_story_id,asset_feed_spec,template_url_spec",token,req);
  return {nome: String(anuncio.name||"Anúncio copiado"),
    criativo: prepararCriativoWhatsappCopia(criativo,paginaOrigem,numeroDestino)};
}

export type CopiaAnuncioPausadoParams={
  contaAdsId:string,conjuntoId:string,nome:string,criativo:Objeto,token:string
};
function bodyCopia(p:CopiaAnuncioPausadoParams,validar:boolean){
  const {contaAdsId,conjuntoId,nome,criativo}=p;
  if(!/^act_\d+$/.test(contaAdsId)||!idOk(conjuntoId))
    throw new Error("ID da Meta inválido");
  if(!nome?.trim()||!obj(criativo.object_story_spec).page_id)
    throw new Error("Nome ou criativo do anúncio inválido");
  const body=new URLSearchParams({
    name:nome.slice(0,200),adset_id:conjuntoId,status:"PAUSED",
    creative:JSON.stringify(criativo)
  });
  if(validar)body.set("execution_options",JSON.stringify(["validate_only"]));
  return body;
}
async function enviarAdPausadoMeta(
 p:CopiaAnuncioPausadoParams,validar:boolean,req:Req
) {
 const body=bodyCopia(p,validar);
 const response=await req(BASE+p.contaAdsId+"/ads",{
  method:"POST",headers:{
   Authorization:"Bearer "+p.token,
   "Content-Type":"application/x-www-form-urlencoded"
  },
  body:body.toString()
 });
 const data=await response.json().catch(()=>({}));
 if(!response.ok||data.error||(!validar&&!idOk(data.id))){
   throw new Error("Meta recusou copiar o anúncio: "+detalharErroMetaAdset(data,response.status).resumo);
 }
 if(validar){
   if(idOk(data.id))throw new Error(
      "A Meta retornou um ID durante a validação. Confira o conjunto antes de continuar.");
   if(data.success!==true)throw new Error("A Meta não confirmou a validação do anúncio.");
   return {validacao_sem_criacao:true};
 }
 return {id:String(data.id)};
}
export async function validarAnuncioPausadoMeta(
 p:CopiaAnuncioPausadoParams,req:Req=fetch
){
 return enviarAdPausadoMeta(p,true,req);
}
export async function criarAnuncioPausadoMeta(
 p:CopiaAnuncioPausadoParams,req:Req=fetch
){
 const data=await enviarAdPausadoMeta(p,false,req);
 return String(data.id);
}
