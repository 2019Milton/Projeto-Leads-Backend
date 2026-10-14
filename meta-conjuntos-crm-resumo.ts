/**
 * Resumo CRM adicionado aos conjuntos Meta, sempre com períodos explícitos.
 * Não atribuir todos os leads de um número ao anúncio: source_type='ad'
 * + source_id que pertence ao anúncio são exigidos na consulta SQL.
 */
export type OrigemCrmResumo = {
  numeros: string[];
  receptores: {numero:string;quantidade:number|string}[];
  anuncios: {conjunto_id:string;hoje:number|string;ultimos_30_dias:number|string}[];
};
const telefone=(v:unknown)=>String(v??"").replace(/\D/g,"");
function quantidade(v:unknown):number{
  const n=Number(v);
  return Number.isSafeInteger(n)&&n>=0?n:0;
}
export function montarMapaAnunciosConjuntos(conjuntos:any[]){
  const porAnuncio=new Map<string,string>();
  for(const cj of conjuntos)for(const ad of Array.isArray(cj.anuncios)?cj.anuncios:[]){
    const id=String(ad?.id||"");
    if(/^\d+$/.test(id))porAnuncio.set(id,String(cj.id));
  }
  return [...porAnuncio.entries()];
}
export function anexarResumoCrmPorConjunto(
  conjuntos:any[],
  resumo:OrigemCrmResumo,
  dataHoje:string
){
  const conhecidos=new Set((resumo.numeros||[]).map(telefone).filter(Boolean));
  const porTelefone=new Map<string,number>();
  for(const x of resumo.receptores||[]){
    const num=telefone(x.numero);
    if(num)porTelefone.set(num,quantidade(x.quantidade));
  }
  const porConjunto=new Map<string,{hoje:number;ultimos_30_dias:number}>();
  for(const x of resumo.anuncios||[]){
    const id=String(x.conjunto_id||"");
    porConjunto.set(id,{
      hoje:quantidade(x.hoje),ultimos_30_dias:quantidade(x.ultimos_30_dias)
    });
  }
  return conjuntos.map(c=>{
    const num=telefone(c.numero_whatsapp);
    const temAnuncios=Array.isArray(c.anuncios)&&c.anuncios.some((a:any)=>/^\d+$/.test(String(a.id||"")));
    const atrib=porConjunto.get(String(c.id));
    return {...c,metricas_crm:{
      data_hoje:dataHoje,
      // null e diferente de 0: null significa telefone nao mapeado no CRM.
      leads_whatsapp_hoje:num&&conhecidos.has(num)?porTelefone.get(num)??0:null,
      leads_anuncio_hoje:temAnuncios?atrib?.hoje??0:null,
      leads_anuncio_30d:temAnuncios?atrib?.ultimos_30_dias??0:null,
      origem_atribuicao:"referral.source_type=ad + referral.source_id do anúncio",
      periodo_atribuicao:"Últimos 30 dias (data de criação do lead)"
    }};
  });
}
