/**
 * Controle explícito e isolado de veiculação Meta (adset / ad).
 * Não altera orçamento, campanha ou criativo, não tenta reenviar sob rate limit.
 * Nunca confunde o status configurado com o status efetivo.
 */
import {detalharErroMetaAdset} from "./meta-erros-diagnostico";
import {erroMetaLimiteChamadas,MENSAGEM_LIMITE_META} from "./meta-edicao-seguranca";
type Req=(url:string,init?:RequestInit)=>Promise<Response>;
type Dict=Record<string,any>;
const BASE="https://graph.facebook.com/v25.0/";
const onlyDigits=(x:unknown)=>/^\d+$/.test(String(x??""));
export type TipoMeta="conjunto"|"anuncio";
export type StatusMeta="ACTIVE"|"PAUSED";
export type StatusMetaRequest={
  campanhaId:string,contaAdsId:string,
  itemId:string,tipo:TipoMeta,statusDesejado:StatusMeta,
  statusEsperado:StatusMeta,token:string
};
function erro(msg:string,httpStatus=409){
 return Object.assign(new Error(msg),{httpStatus});
}
async function consultar(url:string,token:string,req:Req):Promise<Dict>{
 const res=await req(url,{headers:{Authorization:"Bearer "+token}});
 const data=await res.json().catch(()=>({}));
 if(!res.ok||data.error){
   if(erroMetaLimiteChamadas(data))throw erro(MENSAGEM_LIMITE_META,429);
   throw erro("Não foi possível verificar o estado atual na Meta. "+
      detalharErroMetaAdset(data,res.status).resumo,502);
 }
 return data;
}
function confirmarPertencimento(item:Dict,p:StatusMetaRequest){
 if(!item || String(item.id)!==p.itemId ||
    String(item.account_id||"").replace(/^act_/,"")!==p.contaAdsId.slice(4) ||
    String(item.campaign_id)!==p.campanhaId) {
   throw erro("Este item não pertence à campanha e conta Meta selecionadas.",403);
 }
 if(!["ACTIVE","PAUSED"].includes(String(item.status)))
   throw erro("A Meta retornou um status que não pode ser alterado por este controle.");
 if(item.status!==p.statusEsperado)
   throw erro("O status foi alterado na Meta desde a última consulta. Atualize os conjuntos antes de tentar novamente.");
 if(item.status===p.statusDesejado)
   throw erro("Este item já está no estado solicitado. Atualize a consulta.");
}
export async function alterarStatusItemMeta(
 p:StatusMetaRequest, req:Req=fetch
):Promise<{ok:true;tipo:TipoMeta;item_id:string;status_solicitado:StatusMeta;aviso:string}>{
 if(![p.campanhaId,p.itemId].every(onlyDigits)||
    !/^act_\d+$/.test(p.contaAdsId)||
    !["conjunto","anuncio"].includes(p.tipo)||
    !["ACTIVE","PAUSED"].includes(p.statusDesejado)||
    !["ACTIVE","PAUSED"].includes(p.statusEsperado)||
    p.statusDesejado===p.statusEsperado)
   throw erro("Informações de status inválidas.",400);
 const fields="id,account_id,campaign_id,status"+
   (p.tipo==="anuncio"?",adset_id":",destination_type,promoted_object,daily_budget");
 const item=await consultar(BASE+p.itemId+"?fields="+encodeURIComponent(fields),p.token,req);
 confirmarPertencimento(item,p);
 // Se ativar anúncio, o pai precisa existir e pertencer à mesma campanha.
 // É intencional permitir anuncio ACTIVE com conjunto PAUSED para corte seguro.
 if(p.tipo==="anuncio" && p.statusDesejado==="ACTIVE"){
   const adsetId=String(item.adset_id||"");
   if(!onlyDigits(adsetId))throw erro("Conjunto associado ao anúncio inválido.");
   const pai=await consultar(BASE+adsetId+"?fields="+
     encodeURIComponent("id,campaign_id,account_id,status"),p.token,req);
   if(String(pai.id)!==adsetId||
      String(pai.campaign_id)!==p.campanhaId||
      String(pai.account_id||"").replace(/^act_/,"")!==p.contaAdsId.slice(4))
     throw erro("O conjunto do anúncio não pertence à campanha selecionada.",403);
 }
 // Um conjunto sem anúncio ACTIVE não deve começar a veicular por engano.
 if(p.tipo==="conjunto" && p.statusDesejado==="ACTIVE"){
   const resposta=await consultar(BASE+p.itemId+"/ads?fields="+
     encodeURIComponent("id,status")+"&limit=100",p.token,req);
   if(!Array.isArray(resposta.data)||
      !resposta.data.some((a:Dict)=>a.status==="ACTIVE"))
     throw erro("Ative primeiro pelo menos um anúncio deste conjunto. O conjunto continuará pausado.");
 }
 // Após o POST, não consultar imediatamente: a API possui limites de chamadas.
 // Não promete entrega, somente aceitação de atualização de status pelo Graph API.
 const res=await req(BASE+p.itemId,{
   method:"POST",
   headers:{
     Authorization:"Bearer "+p.token,
     "Content-Type":"application/x-www-form-urlencoded"
   },
   body:new URLSearchParams({status:p.statusDesejado}).toString()
 });
 const data=await res.json().catch(()=>({}));
 if(!res.ok||data.error||data.success!==true){
   if(erroMetaLimiteChamadas(data))throw erro(MENSAGEM_LIMITE_META,429);
   throw erro("A Meta não confirmou a alteração de status. "+
     detalharErroMetaAdset(data,res.status).resumo,502);
 }
 return {
   ok:true,tipo:p.tipo,item_id:p.itemId,
   status_solicitado:p.statusDesejado,
   aviso:"A Meta aceitou a alteração do status para "+p.statusDesejado+
     ". Aguarde cerca de 30 segundos e atualize a consulta para confirmar o status efetivo."
 };
}
