// Detalhe por campanha de um dia no painel de performance (linha expansível do dia).
// A Meta já tinha isso; aqui fica a versão do Google Ads. Nada aqui acessa banco, rede
// ou variáveis de ambiente, para poder ser testado.

export interface LinhaGoogleCampanhaDia {
  campaign?: { id?: string | number | null; name?: string | null } | null;
  metrics?: {
    impressions?: string | number | null;
    clicks?: string | number | null;
    costMicros?: string | number | null;
  } | null;
}

export interface LeadsPorCampanha {
  campanha: string | null;
  total: number | string;
}

// Mesmo formato de /meta/performance-diaria/:data/campanhas, para o front usar a mesma
// tabela de detalhe nas duas plataformas.
export interface CampanhaDia {
  campaign_id: string;
  nome: string;
  gasto: number;
  leads: number;
  cliques: number;
  impressoes: number;
  custo_por_lead: number | null;
}

function numero(valor: unknown): number {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

// Os leads do Google gravam o NOME da campanha (não o id), então o casamento é por nome,
// ignorando maiúsculas, acentos e espaços a mais.
export function normalizarNomeCampanha(nome: unknown): string {
  return String(nome ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function montarCampanhasDiaGoogle(
  linhas: LinhaGoogleCampanhaDia[],
  idsPermitidos: Set<string>,
  leadsPorCampanha: LeadsPorCampanha[]
): { campanhas: CampanhaDia[]; leadsSemCampanha: number } {
  // Só entram as campanhas criadas/importadas na plataforma (o mesmo filtro do total do
  // dia), para a soma das linhas bater com o gasto da linha do dia.
  const agregadas = new Map<string, { nome: string; custoMicros: number; cliques: number; impressoes: number }>();

  for (const linha of linhas) {
    const id = String(linha.campaign?.id ?? "");
    if (!id || !idsPermitidos.has(id)) continue;

    const atual = agregadas.get(id) || {
      nome: String(linha.campaign?.name ?? "").trim() || "Campanha sem nome",
      custoMicros: 0,
      cliques: 0,
      impressoes: 0,
    };
    atual.custoMicros += numero(linha.metrics?.costMicros);
    atual.cliques += numero(linha.metrics?.clicks);
    atual.impressoes += numero(linha.metrics?.impressions);
    agregadas.set(id, atual);
  }

  const leadsPorNome = new Map<string, number>();
  let totalLeads = 0;
  for (const item of leadsPorCampanha) {
    const total = numero(item.total);
    totalLeads += total;
    const chave = normalizarNomeCampanha(item.campanha);
    if (!chave) continue;
    leadsPorNome.set(chave, (leadsPorNome.get(chave) || 0) + total);
  }

  const ordenadas = [...agregadas.entries()]
    .map(([id, c]) => ({ id, ...c, gasto: Math.round((c.custoMicros / 1_000_000) * 100) / 100 }))
    .filter((c) => c.gasto > 0 || c.cliques > 0 || c.impressoes > 0)
    .sort((a, b) => b.gasto - a.gasto || b.cliques - a.cliques || a.nome.localeCompare(b.nome, "pt-BR"));

  // Duas campanhas com o mesmo nome não podem contar os mesmos leads duas vezes: os leads
  // do nome ficam com a que mais gastou.
  const nomesJaUsados = new Set<string>();
  let leadsAtribuidos = 0;

  const campanhas: CampanhaDia[] = ordenadas.map((c) => {
    const chave = normalizarNomeCampanha(c.nome);
    const leads = nomesJaUsados.has(chave) ? 0 : leadsPorNome.get(chave) || 0;
    nomesJaUsados.add(chave);
    leadsAtribuidos += leads;

    return {
      campaign_id: c.id,
      nome: c.nome,
      gasto: c.gasto,
      leads,
      cliques: c.cliques,
      impressoes: c.impressoes,
      custo_por_lead: leads > 0 ? c.gasto / leads : null,
    };
  });

  // Leads do dia que não casam com nenhuma campanha da lista (campanha sem gasto no dia,
  // renomeada ou sem nome): entram na linha do dia, mas não têm onde aparecer no detalhe.
  return { campanhas, leadsSemCampanha: Math.max(0, totalLeads - leadsAtribuidos) };
}
