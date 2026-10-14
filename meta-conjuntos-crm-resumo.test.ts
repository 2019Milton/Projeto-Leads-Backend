import {test,expect} from "bun:test";
import {anexarResumoCrmPorConjunto,montarMapaAnunciosConjuntos}
 from "./meta-conjuntos-crm-resumo";
import {consultarResumoConjuntosNoCrm,SQL_METRICAS_CRM_CONJUNTOS}
 from "./meta-conjuntos-crm-consulta";

const conjuntos=[
 {id:"100",nome:"DIHOR 9020",numero_whatsapp:"5521969099020",
  metricas:{conversas_meta:451},anuncios:[{id:"700"},{id:"701"}]},
 {id:"200",nome:"DIHOR 3372",numero_whatsapp:"+55 11 95964-3372",
  metricas:{conversas_meta:7},anuncios:[{id:"777"}]},
 {id:"300",nome:"Não identificado",numero_whatsapp:"5599999999999",
  metricas:{conversas_meta:0},anuncios:[]}
];
const resumo={
 numeros:["5521969099020","5511959643372","5511980930205"],
 receptores:[
  {numero:"5521969099020",quantidade:18},
  {numero:"5511959643372",quantidade:"19"},
  {numero:"5511980930205",quantidade:9}
 ],
 anuncios:[
  {conjunto_id:"100",hoje:4,ultimos_30_dias:26},
  {conjunto_id:"200",hoje:2,ultimos_30_dias:5}
 ]
};

test("mesma campanha: preserva 9020 18 e 3372 19, sem misturar com conversas Meta",()=>{
 const data=anexarResumoCrmPorConjunto(conjuntos,resumo,"2026-10-14");
 expect(data[0].metricas_crm.leads_whatsapp_hoje).toBe(18);
 expect(data[1].metricas_crm.leads_whatsapp_hoje).toBe(19);
 expect(data[1].metricas.conversas_meta).toBe(7);
 expect(data[1].metricas_crm.leads_anuncio_30d).toBe(5);
 expect(data[1].metricas_crm.leads_anuncio_hoje).toBe(2);
 expect(data[0].metricas_crm.leads_anuncio_30d).toBe(26);
 expect(data[0].metricas.conversas_meta).toBe(451);
});
test("se telefone não corresponde a número cadastrado, usa null; não inventa zero",()=>{
 const data=anexarResumoCrmPorConjunto(conjuntos,resumo,"2026-10-14");
 expect(data[2].metricas_crm.leads_whatsapp_hoje).toBeNull();
 expect(data[2].metricas_crm.leads_anuncio_30d).toBeNull();
});
test("se houve consulta válida e nenhum lead, retorna zero verdadeiro",()=>{
 const data=anexarResumoCrmPorConjunto([
   {id:"400",numero_whatsapp:"5511980930205",anuncios:[{id:"909"}]}
 ],{numeros:["5511980930205"],receptores:[],anuncios:[]},"2026-10-14");
 expect(data[0].metricas_crm.leads_whatsapp_hoje).toBe(0);
 expect(data[0].metricas_crm.leads_anuncio_30d).toBe(0);
});
test("mapeamento contém cada anúncio exato do conjunto e não inventa anúncios",()=>{
 expect(montarMapaAnunciosConjuntos(conjuntos))
  .toEqual([["700","100"],["701","100"],["777","200"]]);
});
test("consulta CRM usa autenticação/usuário como parâmetro e faz somente SELECT",async()=>{
 let calls=0;
 const db={query:async(sql:string,params:unknown[])=>{
  calls++;
  expect(sql).toBe(SQL_METRICAS_CRM_CONJUNTOS);
  expect(sql.trim().startsWith("WITH conversas AS MATERIALIZED")).toBe(true);
  expect(sql).toContain("COUNT(DISTINCT c.lead_id)");
  expect(sql).toContain("c.tipo_origem='ad'");
  expect(sql).toContain("AT TIME ZONE 'America/Sao_Paulo'");
  expect(sql).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
  expect(params).toEqual([13,["700","701","777"],["100","100","200"],"2026-10-14"]);
  return {rows:[{resumo}]};
 }};
 expect(await consultarResumoConjuntosNoCrm(db,13,conjuntos,"2026-10-14")).toEqual(resumo);
 expect(calls).toBe(1);
});
test("consulta incompleta não é tratada como zero confirmado",async()=>{
 const db={query:async()=>({rows:[{resumo:{numeros:[],receptores:null,anuncios:[]}}]})};
 await expect(consultarResumoConjuntosNoCrm(db,13,conjuntos,"2026-10-14"))
   .rejects.toThrow("indisponível");
 await expect(consultarResumoConjuntosNoCrm(db,0,conjuntos,"2026-10-14"))
   .rejects.toThrow("inválidos");
});
