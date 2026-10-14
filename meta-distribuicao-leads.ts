/**
 * Atribuição de leads CTWA por anúncio/conjunto e número recebedor.
 * Nunca supõe que todo lead de um WhatsApp pertence a determinada campanha.
 * Apenas dados com campanha local correspondente OU source_id pertencente a um
 * anúncio confirmado na campanha são elegíveis. Source_id prevalece.
 */
type D=Record<string,any>;
export type LinhaLead={
  lead_id:number|string;campanha_id:number|string|null;
  phone_number_id:string|null;source_id:string|null;source_type:string|null;
};
export type ConjuntoMeta={
  id:string;nome:string;status:string;numero:string|null;
  anuncio_ids:string[];orcamento_centavos:number;
  gasto_reais:number|null;
};
const digitos=(v:unknown)=>String(v??"").replace(/\D/g,"");
const normalizarId=(v:unknown)=>/^\d+$/.test(String(v??""))?String(v):"";
export function dataHojeBrasil(now=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"America/Sao_Paulo",
   year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now).map(x=>[x.type,x.value]));
 return [p.year,p.month,p.day].join("-");
}
function dataOffset(hoje:string,delta:number){
 const dt=new Date(hoje+"T12:00:00Z");
 dt.setUTCDate(dt.getUTCDate()+delta);
 return dt.toISOString().slice(0,10);
}
export function intervaloDistribuicao(
 periodo:string,inicio?:string,fim?:string,hoje=dataHojeBrasil()
){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(hoje))throw new Error("Data atual inválida.");
 if(periodo==="hoje")return {inicio:hoje,fim:hoje,periodo};
 if(periodo==="ontem"){const d=dataOffset(hoje,-1);return {inicio:d,fim:d,periodo};}
 if(periodo==="7d")return {inicio:dataOffset(hoje,-6),fim:hoje,periodo};
 if(periodo==="30d")return {inicio:dataOffset(hoje,-29),fim:hoje,periodo};
 if(periodo!=="personalizado")throw new Error("Período inválido.");
 const ok=(v?:string)=>!!v&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&
   !Number.isNaN(new Date(v+"T12:00:00Z").getTime())&&
   new Date(v+"T12:00:00Z").toISOString().slice(0,10)===v;
 if(!ok(inicio)||!ok(fim))throw new Error("Datas devem estar em AAAA-MM-DD.");
 const delta=Math.round((Date.parse(fim+"T12:00:00Z")-Date.parse(inicio+"T12:00:00Z"))/86400000);
 if(delta<0||delta>89||fim>hoje)throw new Error("Selecione um intervalo de até 90 dias, sem datas futuras.");
 return {inicio:inicio!,fim:fim!,periodo};
}
const arr=(v:unknown):D[]=>Array.isArray(v)?v:[];
const obj=(v:unknown):D=>v&&typeof v==="object"&&!Array.isArray(v)?v as D:{};
function dadosInsight(c:D):number|null{
 const a=arr(obj(c.insights).data);
 if(!a.length)return null;
 const n=Number(a[0].spend);
 return Number.isFinite(n)&&n>=0?Math.round(n*100)/100:null;
}
export function mapearConjuntosMeta(dados:unknown):ConjuntoMeta[]{
 const payload=obj(dados);
 if(!Array.isArray(payload.data))throw new Error("Meta não retornou a lista completa dos conjuntos.");
 if(payload.paging?.next)throw new Error("Há mais de 100 conjuntos na campanha. Necessária paginação para atribuição segura.");
 return payload.data.map((c:D)=>{
   const ads=obj(c.ads);
   if(ads.paging?.next)throw new Error("Há mais anúncios que o limite por conjunto. Necessária paginação.");
   const id=normalizarId(c.id);
   if(!id)throw new Error("ID de conjunto inválido na resposta Meta.");
   return {
     id,nome:String(c.name||"Conjunto "+id),status:String(c.status||""),
     numero:digitos(obj(c.promoted_object).whatsapp_phone_number)||null,
     anuncio_ids:arr(ads.data).map(a=>normalizarId(a.id)).filter(Boolean),
     orcamento_centavos:Number(c.daily_budget)||0,
     gasto_reais:dadosInsight(c)
   };
 });
}
export function agregarDistribuicao(
 rows:LinhaLead[],conjuntos:ConjuntoMeta[],
 numeros:{phone_number_id:string;numero:string;display_name:string}[],
 campanhaLocalId:number
){
 const ads=new Map<string,ConjuntoMeta>();
 for(const c of conjuntos)for(const id of c.anuncio_ids)ads.set(id,c);
 const porConjunto=conjuntos.map(c=>({...c,leads:0}));
 const porId=new Map(porConjunto.map(c=>[c.id,c]));
 const numbers=new Map<string,{phone_number_id:string;numero:string;nome:string;leads:number;atribuidos:number;sem_conjunto:number}>();
 for(const n of numeros){
   const id=String(n.phone_number_id||"");
   if(id)numbers.set(id,{phone_number_id:id,numero:digitos(n.numero),
     nome:String(n.display_name||"WhatsApp"),leads:0,atribuidos:0,sem_conjunto:0});
 }
 // Cada lead conta uma só vez na campanha e num único número; números
 // diferentes com o mesmo contato podem originar leads independentes.
 const relacionados=new Map<string,{phone:string;conjunto:string|null;forte:boolean}>();
 for(const linha of rows){
   const phone=String(linha.phone_number_id||"");
   if(!phone||!numbers.has(phone))continue;
   const src=normalizarId(linha.source_id);
   const conjunto=src?ads.get(src):undefined;
   const correspondeCampanha=String(linha.campanha_id??"")===String(campanhaLocalId);
   // Um source_id de outro anúncio não é prova de pertencimento.
   if(!conjunto&&!correspondeCampanha)continue;
   const leadId=String(linha.lead_id);
   const existente=relacionados.get(leadId);
   if(!existente||(!existente.forte&&!!conjunto)){
     relacionados.set(leadId,{phone,conjunto:conjunto?.id||null,forte:!!conjunto});
   }
 }
 let semConjunto=0,atribuidos=0,semNumero=0;
 for(const item of relacionados.values()){
   const numero=numbers.get(item.phone);
   if(!numero){semNumero++;continue;}
   numero.leads++;
   if(item.conjunto){
     atribuidos++;numero.atribuidos++;
     const c=porId.get(item.conjunto);if(c)c.leads++;
   }else{
     semConjunto++;numero.sem_conjunto++;
   }
 }
 // Gasto é dado pela Meta (Insights), leads são registros reais do CRM.
 const grupos=porConjunto.map(c=>({
   ...c,custo_por_lead:c.gasto_reais!==null&&c.leads>0?
     Math.round(c.gasto_reais/c.leads*100)/100:null
 }));
 return {
   total_leads:relacionados.size,leads_atribuidos:atribuidos,
   sem_conjunto:semConjunto,sem_numero:semNumero,
   numeros:[...numbers.values()].filter(n=>n.leads>0||
     conjuntos.some(c=>c.numero&&c.numero===n.numero)),
   conjuntos:grupos
 };
}
