/**
 * Edição explícita e auditável dos orçamentos diários de conjuntos Meta ABO.
 * A campanha existente e os status de veiculação nunca são modificados.
 */
type Req = (url:string, init?:RequestInit)=>Promise<Response>;
type Item = { id:string; centavos:number; esperado_centavos:number; esperado_status:string };
const BASE="https://graph.facebook.com/v25.0/";
const numeros=(v:unknown)=>/^\d+$/.test(String(v||""));
const valor=(v:unknown)=>Number(v||0);

export function validarDistribuicaoConjuntos(
 itens:Item[], totalCentavos:number
) {
 if(!Array.isArray(itens)||!itens.length||itens.length>30)
   throw new Error("Selecione entre 1 e 30 conjuntos para distribuir o orçamento.");
 if(!Number.isSafeInteger(totalCentavos)||totalCentavos<1500||totalCentavos>30000000)
   throw new Error("Informe um total diário entre R$ 15 e R$ 300.000.");
 const ids=new Set<string>();
 let soma=0;
 for(const x of itens) {
   if(!numeros(x.id)||ids.has(String(x.id)))
     throw new Error("Conjunto inválido ou repetido.");
   ids.add(String(x.id));
   for(const n of [x.centavos,x.esperado_centavos]) {
     if(!Number.isSafeInteger(n)||n<0||n>30000000)
       throw new Error("Orçamento de conjunto inválido.");
   }
   if(x.centavos<1500)
     throw new Error("Cada conjunto deve receber no mínimo R$ 15/dia.");
   if(!["ACTIVE","PAUSED"].includes(String(x.esperado_status)))
     throw new Error("Status anterior do conjunto inválido.");
   soma+=x.centavos;
 }
 if(soma!==totalCentavos) throw new Error("A soma dos conjuntos não corresponde ao total solicitado.");
 return { total_centavos:soma, quantidade:itens.length };
}

export function repartirIgualmenteCentavos(total:number,quantidade:number):number[] {
 if(!Number.isSafeInteger(total)||!Number.isSafeInteger(quantidade)||quantidade<1||quantidade>30)
   throw new Error("Distribuição inválida");
 const base=Math.floor(total/quantidade);
 return Array.from({length:quantidade},(_,i)=>base+(i<total%quantidade?1:0));
}

async function consultar(url:string,token:string,req:Req) {
 const u=new URL(url);
 if(u.hostname!=="graph.facebook.com"||u.protocol!=="https:")throw new Error("Endereço Meta inválido");
 const res=await req(url,{headers:{Authorization:"Bearer "+token}});
 const data=await res.json().catch(()=>({}));
 if(!res.ok||data.error) throw new Error("Erro ao consultar orçamento na Meta ("+(data.error?.code||res.status)+")");
 return data;
}

async function atualizar(id:string,centavos:number,token:string,req:Req) {
 const res=await req(BASE+id,{
   method:"POST",
   headers:{Authorization:"Bearer "+token,"Content-Type":"application/x-www-form-urlencoded"},
   body:new URLSearchParams({daily_budget:String(centavos)}).toString()
 });
 const data=await res.json().catch(()=>({}));
 if(!res.ok||data.error||data.success!==true)
   throw new Error("Meta recusou orçamento do conjunto "+id+" (código "+(data.error?.code||res.status)+")");
}

export async function distribuirOrcamentosMeta(
 params:{campanhaId:string,contaAdsId:string,itens:Item[],totalCentavos:number,token:string},
 req:Req=fetch
) {
 const {campanhaId,contaAdsId,itens,totalCentavos,token}=params;
 if(!numeros(campanhaId)||!/^act_\d+$/.test(contaAdsId))throw new Error("Campanha/conta inválida");
 validarDistribuicaoConjuntos(itens,totalCentavos);
 const campanha=await consultar(BASE+campanhaId+"?fields=id,account_id,daily_budget,lifetime_budget",token,req);
 if(String(campanha.account_id||"").replace(/^act_/,"")!==contaAdsId.slice(4))
   throw new Error("Campanha vinculada a outra conta Meta");
 if(valor(campanha.daily_budget)>0||valor(campanha.lifetime_budget)>0)
   throw new Error("Campanha CBO: distribuição individual de orçamentos não permitida.");
 // Antes de qualquer escrita, confirma estado atual, conta, campanha e orçamento de todos os conjuntos.
 const atuais=await Promise.all(itens.map(x=>consultar(
   BASE+x.id+"?fields=id,account_id,campaign_id,daily_budget,status",token,req
 )));
 for(let i=0;i<itens.length;i++){
   const atual=atuais[i], item=itens[i];
   if(String(atual.id)!==String(item.id)||
      String(atual.account_id||"").replace(/^act_/,"")!==contaAdsId.slice(4)||
      String(atual.campaign_id)!==campanhaId)
     throw new Error("Um conjunto não pertence à campanha/conta selecionada.");
   if(String(atual.status)!==String(item.esperado_status)||
      valor(atual.daily_budget)!==item.esperado_centavos)
     throw new Error("Os conjuntos foram alterados desde a consulta. Atualize antes de distribuir o orçamento.");
 }
 const feitos:{id:string;anterior:number}[]=[];
 try {
   for(const x of itens) {
     if(x.centavos===x.esperado_centavos)continue;
     await atualizar(x.id,x.centavos,token,req);
     feitos.push({id:x.id,anterior:x.esperado_centavos});
   }
   const lidos=await Promise.all(itens.map(x=>consultar(
     BASE+x.id+"?fields=id,daily_budget,status",token,req
   )));
   for(let i=0;i<itens.length;i++){
     if(valor(lidos[i].daily_budget)!==itens[i].centavos||
        String(lidos[i].status)!==itens[i].esperado_status)
       throw new Error("Meta não confirmou o orçamento/status após alteração.");
   }
   return {ok:true,alterados:feitos.length,total_centavos:totalCentavos};
 } catch(error){
   // Compensação conservadora: tenta devolver os valores anteriores dos já escritos.
   const restauracoes=await Promise.allSettled(feitos.reverse().map(x=>
      atualizar(x.id,x.anterior,token,req)
   ));
   const falhasRestauracao=restauracoes.filter(x=>x.status==="rejected").length;
   return {ok:false,parcial:falhasRestauracao>0,
     restauracao_confirmada:falhasRestauracao===0,
     alterados_tentados:feitos.length,
     error: (error instanceof Error?error.message:"Erro na Meta")+
       (falhasRestauracao>0
         ? " ATENÇÃO: reversão incompleta; confira os orçamentos na Meta antes de tentar novamente."
         : " Os valores anteriores foram reenviados para reversão; confira a Meta.")
   };
 }
}
