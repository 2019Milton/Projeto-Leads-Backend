/** Diagnóstico seguro de erros do Graph API sem expor token ou payload completo. */
type Dict=Record<string,unknown>;
const dict=(o:unknown):Dict=>o&&typeof o==="object"&&!Array.isArray(o)?o as Dict:{};
const safe=(value:unknown,max=350)=>{
 const raw=String(value??"").trim();
 return raw.replace(/Bearer\s+\S+/gi,"Bearer [oculto]")
   .replace(/\bEAA[A-Za-z0-9_\-]{22,}\b/g,"[token oculto]")
   .replace(/access_token\s*[=:]\s*[^\s,&]+/gi,"access_token=[oculto]")
   .slice(0,max);
};
export type MetaApiErroDetalhado={
 codigo:number;
 subcodigo:number|null;
 titulo:string|null;
 mensagem:string|null;
 campo:string|null;
 fbtrace_id:string|null;
 resumo:string;
};
export function detalharErroMetaAdset(resposta:unknown,httpStatus:number):MetaApiErroDetalhado{
 const dados=dict(resposta),e=dict(dados.error);
 const codigo=Number(e.code)||httpStatus||0;
 const sub=Number(e.error_subcode);
 const subcodigo=Number.isSafeInteger(sub)&&sub>0?sub:null;
 const titulo=e.error_user_title?safe(e.error_user_title,160):null;
 const mensagem=e.error_user_msg?safe(e.error_user_msg,650):
   e.message?safe(e.message,350):null;
 const raw=e.error_data;
 let extra=dict(raw);
 if(typeof raw==="string"){
   try{extra=dict(JSON.parse(raw));}catch{}
 }
 const candidatos:unknown[]=[];
 if(typeof extra.blame_field==="string")candidatos.push(extra.blame_field);
 if(Array.isArray(extra.blame_field_specs)){
   for(const path of extra.blame_field_specs){
     if(Array.isArray(path))candidatos.push(path.join("."));
   }
 }
 // Campos são nomes técnicos curtos, nunca um objeto/valor da campanha.
 const campos=candidatos.filter(x=>typeof x==="string"&&
   /^[a-z_0-9.]{1,110}$/i.test(x)).slice(0,3) as string[];
 const campo=campos.length?campos.join(", "):null;
 const fbtrace_id=typeof e.fbtrace_id==="string"&&/^[A-Za-z0-9_-]{5,100}$/.test(e.fbtrace_id)?e.fbtrace_id:null;
 const nome=[titulo,mensagem].filter(Boolean);
 const explica=nome.length?Array.from(new Set(nome)).join(": "):"A Meta não enviou explicação detalhada.";
 const resumo=[
   "Meta recusou a configuração do conjunto (código "+codigo+(subcodigo?", subcódigo "+subcodigo:"")+").",
   explica,
   ...(campo?["Campo indicado: "+campo+"."]:[]),
   ...(fbtrace_id?["Referência Meta: "+fbtrace_id+"."]:[])
 ].join(" ");
 return {codigo,subcodigo,titulo,mensagem,campo,fbtrace_id,resumo};
}
