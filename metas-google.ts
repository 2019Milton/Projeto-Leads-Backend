// Metas de conversão (o que conta no lance "Maximizar conversões") de uma
// campanha do Google Ads criada pela plataforma.
//
// Visto na conferência de 2026-09-30: as campanhas herdam as metas da CONTA,
// e contas reais têm metas que nada têm a ver com a campanha (visualização de
// página do site, compras de outro negócio da mesma conta...). Com isso o
// Google otimiza pela coisa errada — e, em uma conta, a meta do próprio
// formulário do Google nem estava entre as usadas.
//
// Regra: só contam no lance da campanha
// - a meta principal do destino, hospedada pelo Google (formulário enviado =
//   SUBMIT_LEAD_FORM; WhatsApp = CONTACT), e
// - as metas das ações de conversão da plataforma (lead qualificado e lead
//   convertido, enviadas pela plataforma — origem WEBSITE).
// No destino site ("Direto para o site" com o código instalado), a meta
// principal é a da ação "Lead do site" da plataforma (origem WEBSITE).
// Todo o resto é desligado SÓ nessa campanha (a conta não muda). Se a meta
// principal ainda não existir (o Google cria depois que aprova o formulário
// ou o número), não mexe em nada — desligar o resto deixaria a campanha sem
// o que otimizar.

export type MetaCampanhaGoogle = {
  resourceName: string;
  category: string;
  origin: string;
  biddable: boolean;
};

// Categorias das ações de conversão que a plataforma cria (ver
// obterOuCriarConversionActionGoogle): as próprias de funil de lead do
// Google; DEFAULT ("Outros") só quando a conta recusa essas.
export const CATEGORIA_ACAO_GOOGLE = {
  qualified: "QUALIFIED_LEAD",
  closed: "CONVERTED_LEAD"
} as const;

// Ação "Lead do site" (tipo WEBPAGE, registrada pela tag do Google no
// formulário do site): formulário enviado no site. Validada com validateOnly
// nas 3 contas conectadas em 05/10/2026.
export const CATEGORIA_ACAO_LEAD_SITE_GOOGLE = "SUBMIT_LEAD_FORM";
export const NOME_ACAO_LEAD_SITE_GOOGLE = "Plataforma de Leads - Lead do site";

export function lerMetaCampanhaGoogle(linha: any): MetaCampanhaGoogle | null {
  const meta = linha?.campaignConversionGoal ?? linha?.campaign_conversion_goal;
  const resourceName = meta?.resourceName ?? meta?.resource_name;
  if (!resourceName) return null;
  return {
    resourceName: String(resourceName),
    category: String(meta?.category || ""),
    origin: String(meta?.origin || ""),
    biddable: meta?.biddable === true
  };
}

// origemPrincipal: GOOGLE_HOSTED pro formulário e o WhatsApp do Google;
// WEBSITE pro destino site, cuja meta principal é a ação "Lead do site" da
// plataforma (SUBMIT_LEAD_FORM, registrada pela tag no formulário do site).
export function planejarMetasCampanhaGoogle(
  metas: MetaCampanhaGoogle[],
  categoriaPrincipal: string,
  categoriasAcoesPlataforma: string[],
  origemPrincipal: "GOOGLE_HOSTED" | "WEBSITE" = "GOOGLE_HOSTED"
): { resourceName: string; biddable: boolean }[] | null {
  const chave = (categoria: string, origem: string) => `${categoria}/${origem}`;
  const principal = chave(categoriaPrincipal, origemPrincipal);
  if (!metas.some(m => chave(m.category, m.origin) === principal)) return null;

  const ligadas = new Set([principal, ...categoriasAcoesPlataforma.filter(Boolean).map(c => chave(c, "WEBSITE"))]);
  return metas
    // Meta "UNKNOWN" (categoria ou origem que a API não expõe) não aceita
    // alteração: o Google recusa o resource name ("'UNKNOWN' part of the
    // resource name is invalid", visto em conta real em 05/10/2026) e a
    // recusa derrubaria o lote inteiro. Fica como está.
    .filter(m => m.category !== "UNKNOWN" && m.origin !== "UNKNOWN")
    .map(m => ({ meta: m, alvo: { resourceName: m.resourceName, biddable: ligadas.has(chave(m.category, m.origin)) } }))
    .filter(({ meta, alvo }) => alvo.biddable !== meta.biddable)
    .map(({ alvo }) => alvo);
}
