/**
 * Retoma apenas a cópia de um anúncio em conjunto Meta previamente criado e PAUSADO.
 * Não cria outro conjunto, não modifica budgets/status e bloqueia anúncios duplicados.
 */
import { consultarMetaDuplicacao, verificarAnuncioOriginalWhatsapp,
  criarAnuncioPausadoMeta, validarAnuncioPausadoMeta } from "./meta-duplicacao-anuncio";

type Dict=Record<string,any>;
type Req=(url:string, init?:RequestInit)=>Promise<Response>;
const BASE="https://graph.facebook.com/v25.0/";
const idOk=(v:unknown)=>/^\d+$/.test(String(v??""));
const obj=(v:unknown):Dict=>v&&typeof v==="object"&&!Array.isArray(v)?v as Dict:{};
const lock=new Set<string>();

export type CopiaAnuncioEmConjuntoParams={
  campanhaId:string;contaAdsId:string;conjuntoDestinoId:string;
  conjuntoOrigemId:string;anuncioOrigemId:string;numeroWhatsapp:string;
  token:string;
};

async function prepararCopiaParaConjuntoExistente(p:CopiaAnuncioEmConjuntoParams,req:Req) {
  if(![p.campanhaId,p.conjuntoDestinoId,p.conjuntoOrigemId,p.anuncioOrigemId].every(idOk)
    ||!/^act_\d+$/.test(p.contaAdsId)||!/^55\d{10,11}$/.test(p.numeroWhatsapp))
    throw new Error("Identificadores, conta Meta ou WhatsApp inválidos.");
  if(p.conjuntoDestinoId===p.conjuntoOrigemId)
    throw new Error("Origem e destino devem ser conjuntos diferentes.");
  const [destino,origem]=await Promise.all([
    consultarMetaDuplicacao(p.conjuntoDestinoId,
      "id,campaign_id,account_id,status,destination_type,promoted_object",p.token,req),
    consultarMetaDuplicacao(p.conjuntoOrigemId,
      "id,campaign_id,account_id,promoted_object",p.token,req)
  ]);
  for(const x of [destino,origem]){
    if(String(x.campaign_id)!==p.campanhaId ||
      String(x.account_id||"").replace(/^act_/,"")!==p.contaAdsId.slice(4)){
      throw new Error("Conjunto não pertence a esta campanha e conta de anúncios.");
    }
  }
  if(String(destino.status)!=="PAUSED" || String(destino.destination_type)!=="WHATSAPP")
    throw new Error("O conjunto de destino precisa estar PAUSADO e com destino WhatsApp.");
  const promovido=obj(destino.promoted_object);
  if(String(promovido.whatsapp_phone_number||"").replace(/\D/g,"")!==p.numeroWhatsapp)
    throw new Error("O WhatsApp do conjunto não corresponde ao número conectado e escolhido.");
  const paginaOrigem=String(obj(origem.promoted_object).page_id||"");
  if(!idOk(paginaOrigem)||String(promovido.page_id||"")!==paginaOrigem)
    throw new Error("Os conjuntos precisam pertencer à mesma Página da Meta.");
  await validarSemAnuncios(p.conjuntoDestinoId,p.token,req);
  const copia=await verificarAnuncioOriginalWhatsapp({
    campanhaId:p.campanhaId,contaAdsId:p.contaAdsId,
    conjuntoOrigemId:p.conjuntoOrigemId,anuncioOrigemId:p.anuncioOrigemId,
    paginaOrigem,numeroDestino:p.numeroWhatsapp,token:p.token
  },req);
  return {copia,nome:copia.nome+" - WhatsApp "+p.numeroWhatsapp.slice(-4)};
}

async function validarSemAnuncios(conjuntoId:string,token:string,req:Req){
  const url=BASE+conjuntoId+"/ads?fields="+encodeURIComponent("id,status,name")+"&limit=3";
  const r=await req(url,{headers:{Authorization:"Bearer "+token}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok||data.error)throw new Error("Não foi possível verificar os anúncios do conjunto de destino na Meta.");
  if(!Array.isArray(data.data))throw new Error("A Meta não retornou a lista de anúncios do conjunto.");
  if(data.data.length)throw new Error("O conjunto já possui anúncio. Atualize a página antes de tentar copiar novamente.");
}

async function conferirAnuncioCopiado(p:CopiaAnuncioEmConjuntoParams,anuncioId:string,req:Req){
  let pausado=false,numeroCriativoConfirmado=false;
  try {
    const ad=await consultarMetaDuplicacao(anuncioId,
      "id,status,adset_id,creative{id}",p.token,req);
    pausado=String(ad.adset_id)===p.conjuntoDestinoId && String(ad.status)==="PAUSED";
    const creativeId=String(obj(ad.creative).id||"");
    if(pausado&&idOk(creativeId)){
      const criativo=await consultarMetaDuplicacao(creativeId,"id,object_story_spec",p.token,req);
      const story=obj(criativo.object_story_spec);
      const conteudo=obj(story.link_data||story.video_data);
      const cta=obj(obj(conteudo.call_to_action).value);
      numeroCriativoConfirmado=String(cta.whatsapp_number||"").replace(/\D/g,"")===p.numeroWhatsapp;
    }
  } catch { /* Resultado inconclusivo não é anunciado como sucesso */ }
  return {pausado,numeroCriativoConfirmado};
}

export async function validarCopiaAnuncioEmConjuntoExistente(
 p:CopiaAnuncioEmConjuntoParams,req:Req=fetch
){
  const {copia,nome}=await prepararCopiaParaConjuntoExistente(p,req);
  await validarAnuncioPausadoMeta({
    contaAdsId:p.contaAdsId,conjuntoId:p.conjuntoDestinoId,
    nome,criativo:copia.criativo,token:p.token
  },req);
  return {
    ok:true,validacao_sem_criacao:true,
    conjunto_id:p.conjuntoDestinoId,
    aviso:"A Meta aceitou a validação da cópia do anúncio. Nenhum conjunto ou anúncio foi criado."
  };
}

export async function copiarAnuncioEmConjuntoExistente(
 p:CopiaAnuncioEmConjuntoParams,req:Req=fetch
){
  const key=p.contaAdsId+":"+p.conjuntoDestinoId;
  if(lock.has(key))throw new Error("Já existe uma cópia em andamento para este conjunto.");
  lock.add(key);
  try{
    const {copia,nome}=await prepararCopiaParaConjuntoExistente(p,req);
    await validarAnuncioPausadoMeta({
      contaAdsId:p.contaAdsId,conjuntoId:p.conjuntoDestinoId,
      nome,criativo:copia.criativo,token:p.token
    },req);
    // Checagem final para não duplicar anúncio se outra pessoa criou nesse intervalo.
    await validarSemAnuncios(p.conjuntoDestinoId,p.token,req);
    const anuncioId=await criarAnuncioPausadoMeta({
      contaAdsId:p.contaAdsId,conjuntoId:p.conjuntoDestinoId,
      nome,criativo:copia.criativo,token:p.token
    },req);
    const status=await conferirAnuncioCopiado(p,anuncioId,req);
    const completo=status.pausado&&status.numeroCriativoConfirmado;
    return {
      ok:completo,parcial:!completo,
      conjunto_id:p.conjuntoDestinoId,anuncio_id:anuncioId,
      status:status.pausado?"PAUSED":"NAO_CONFIRMADO",
      numero_whatsapp:p.numeroWhatsapp,
      numero_criativo_confirmado:status.numeroCriativoConfirmado,
      aviso:completo
       ? "Anúncio criado e confirmado PAUSADO no conjunto existente. Confira a prévia da Meta antes de ativar."
       : "Anúncio criado, mas o status ou WhatsApp do criativo não foi confirmado. Confira os IDs na Meta e NÃO repita a criação."
    };
  }finally{lock.delete(key);}
}
