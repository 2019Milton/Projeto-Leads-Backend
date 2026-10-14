import type {OrigemCrmResumo} from "./meta-conjuntos-crm-resumo";
import {montarMapaAnunciosConjuntos} from "./meta-conjuntos-crm-resumo";
/**
 * Apenas SELECT de leads já criados. Agregação SQL COUNT(DISTINCT lead_id):
 * - hoje por número da empresa (qualquer origem)
 * - últimos 30 dias por adset comprovado por referral ad/source_id
 * Não mistura leads de outros usuários e não soma o mesmo lead duas vezes
 * quando ele reaparece em múltiplos anúncios do mesmo conjunto.
 */
export const SQL_METRICAS_CRM_CONJUNTOS=`
WITH conversas AS MATERIALIZED (
  SELECT
    l.id AS lead_id,
    regexp_replace(COALESCE(wn.numero,''),'[^0-9]','','g') AS numero_receptor,
    wc.referral->>'source_id' AS anuncio_origem_id,
    wc.referral->>'source_type' AS tipo_origem,
    (l.criado_em AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date AS dia
  FROM leads l
  JOIN whatsapp_conversas wc
    ON wc.lead_id=l.id AND wc.usuario_id=l.usuario_id
  LEFT JOIN whatsapp_numeros wn
    ON wn.usuario_id=l.usuario_id AND wn.phone_number_id=wc.phone_number_id
  WHERE l.usuario_id=$1
    AND l.criado_em >= ($4::date - INTERVAL '31 days')
    AND l.criado_em <  ($4::date + INTERVAL '2 days')
),
mapeamento_ads AS (
  SELECT ad_id,conjunto_id FROM unnest($2::text[],$3::text[])
    AS anuncio(ad_id,conjunto_id)
),
receptores_hoje AS (
  SELECT numero_receptor AS numero, COUNT(DISTINCT lead_id)::int AS quantidade
  FROM conversas
  WHERE dia=$4::date AND numero_receptor<>''
  GROUP BY numero_receptor
),
atribuicoes AS (
  SELECT ads.conjunto_id,
    COUNT(DISTINCT c.lead_id) FILTER (WHERE c.dia=$4::date)::int AS hoje,
    COUNT(DISTINCT c.lead_id)::int AS ultimos_30_dias
  FROM conversas c
  JOIN mapeamento_ads ads ON ads.ad_id=c.anuncio_origem_id
  WHERE c.tipo_origem='ad'
    AND c.dia BETWEEN ($4::date - INTERVAL '29 days') AND $4::date
  GROUP BY ads.conjunto_id
)
SELECT jsonb_build_object(
  'numeros', COALESCE((
    SELECT jsonb_agg(DISTINCT regexp_replace(numero,'[^0-9]','','g'))
    FROM whatsapp_numeros
    WHERE usuario_id=$1 AND numero IS NOT NULL AND numero<>''
  ),'[]'::jsonb),
  'receptores', COALESCE((
    SELECT jsonb_agg(to_jsonb(receptores_hoje)) FROM receptores_hoje
  ),'[]'::jsonb),
  'anuncios', COALESCE((
    SELECT jsonb_agg(to_jsonb(atribuicoes)) FROM atribuicoes
  ),'[]'::jsonb)
) AS resumo
`;
type Queryable={query:(sql:string,params:unknown[])=>Promise<{rows:any[]}>};
export async function consultarResumoConjuntosNoCrm(
  db:Queryable,usuarioId:number,conjuntos:any[],dataHoje:string
):Promise<OrigemCrmResumo>{
 if(!Number.isSafeInteger(usuarioId)||usuarioId<=0||!/^\d{4}-\d{2}-\d{2}$/.test(dataHoje))
   throw new Error("Consulta CRM: usuário ou data inválidos.");
 const ads=montarMapaAnunciosConjuntos(conjuntos);
 const result=await db.query(SQL_METRICAS_CRM_CONJUNTOS,[
   usuarioId,ads.map(x=>x[0]),ads.map(x=>x[1]),dataHoje
 ]);
 const resumo=result.rows?.[0]?.resumo;
 if(!resumo||!Array.isArray(resumo.numeros)||!Array.isArray(resumo.receptores)||
    !Array.isArray(resumo.anuncios))throw new Error("Resumo CRM indisponível.");
 return resumo as OrigemCrmResumo;
}
