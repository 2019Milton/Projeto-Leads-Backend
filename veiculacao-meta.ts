// Veiculação real de uma campanha da Meta, a partir do effective_status de cada anúncio
// (GET /{conta}/ads?fields=id,campaign_id,adset_id,effective_status).
//
// Uma campanha só veicula se a campanha, o conjunto de anúncios e o anúncio estiverem
// ligados. A campanha pode estar ACTIVE e os anúncios mesmo assim não rodarem porque o
// conjunto (ADSET_PAUSED) ou o próprio anúncio (PAUSED) está pausado.
//
// Nada aqui acessa banco, rede ou variáveis de ambiente, para poder ser testado.

// Do pior para o melhor: quando os anúncios de uma campanha têm status diferentes, o
// primeiro da lista que aparecer vira o status da campanha (um anúncio reprovado ou
// com problema de cobrança precisa aparecer mesmo que outros estejam rodando).
export const PRIORIDADE_VEICULACAO_META = [
  "WITH_ISSUES",
  "DISAPPROVED",
  "PENDING_BILLING_INFO",
  "PENDING_REVIEW",
  "IN_PROCESS",
  "PREAPPROVED",
  "ADSET_PAUSED",
  "CAMPAIGN_PAUSED",
  "PAUSED",
  "ACTIVE",
  "ARCHIVED",
  "DELETED",
] as const;

export interface AnuncioMeta {
  campaign_id?: string | null;
  adset_id?: string | null;
  effective_status?: string | null;
}

export interface ConjuntosCampanha {
  total: number;
  ativos: number;
  pausados: number;
}

export interface VeiculacaoCampanha {
  // Status que representa a campanha (ver PRIORIDADE_VEICULACAO_META).
  status: string;
  // A campanha está ligada, mas nenhum anúncio veicula porque o conjunto ou os
  // anúncios estão pausados. Só faz sentido junto com o status ACTIVE da campanha.
  semVeicular: boolean;
  // Contagem por conjunto de anúncios; null quando a Meta não devolveu o adset_id.
  conjuntos: ConjuntosCampanha | null;
}

// Pausas que deixam de valer quando ainda há um anúncio ativo: a campanha está
// veiculando, só uma parte dela está desligada.
const PAUSAS_PARCIAIS = new Set(["ADSET_PAUSED", "PAUSED"]);

function contarConjuntos(anuncios: AnuncioMeta[]): ConjuntosCampanha | null {
  const porConjunto = new Map<string, string[]>();

  for (const anuncio of anuncios) {
    const conjunto = String(anuncio.adset_id ?? "");
    if (!conjunto || !anuncio.effective_status) continue;
    const lista = porConjunto.get(conjunto) || [];
    lista.push(anuncio.effective_status);
    porConjunto.set(conjunto, lista);
  }

  if (!porConjunto.size) return null;

  let ativos = 0;
  let pausados = 0;
  for (const statuses of porConjunto.values()) {
    if (statuses.includes("ACTIVE")) ativos++;
    else if (statuses.includes("ADSET_PAUSED")) pausados++;
  }
  return { total: porConjunto.size, ativos, pausados };
}

export function resolverVeiculacaoPorCampanha(
  anuncios: AnuncioMeta[]
): Record<string, VeiculacaoCampanha> {
  const porCampanha = new Map<string, AnuncioMeta[]>();

  for (const anuncio of anuncios) {
    const campanha = String(anuncio.campaign_id ?? "");
    if (!campanha || !anuncio.effective_status) continue;
    const lista = porCampanha.get(campanha) || [];
    lista.push(anuncio);
    porCampanha.set(campanha, lista);
  }

  const resultado: Record<string, VeiculacaoCampanha> = {};

  for (const [campanha, lista] of porCampanha) {
    const statuses = lista.map((a) => String(a.effective_status));
    const melhor = PRIORIDADE_VEICULACAO_META.find((p) => statuses.includes(p));
    if (!melhor) continue;

    const temAtivo = statuses.includes("ACTIVE");
    const pausaParcial = PAUSAS_PARCIAIS.has(melhor);

    resultado[campanha] = {
      status: temAtivo && pausaParcial ? "ACTIVE" : melhor,
      semVeicular: !temAtivo && pausaParcial,
      conjuntos: contarConjuntos(lista),
    };
  }

  return resultado;
}

// "Todos os 3 conjuntos de anúncios estão pausados", "1 de 3 conjuntos de anúncios está
// pausado" ou, quando a Meta não devolveu os conjuntos, o texto no singular de sempre.
export function descreverConjuntosPausados(conjuntos: ConjuntosCampanha | null): string {
  if (!conjuntos || conjuntos.total <= 1) return "O conjunto de anúncios está pausado";

  const { total, pausados } = conjuntos;
  if (pausados >= total) return `Todos os ${total} conjuntos de anúncios estão pausados`;
  return `${pausados} de ${total} conjuntos de anúncios ${pausados === 1 ? "está pausado" : "estão pausados"}`;
}

// Campanha veiculando com parte dos conjuntos desligados.
export function veiculacaoParcial(
  veiculacao: Pick<VeiculacaoCampanha, "status" | "conjuntos"> | null | undefined
): boolean {
  return (
    veiculacao?.status === "ACTIVE" &&
    Boolean(veiculacao.conjuntos && veiculacao.conjuntos.pausados > 0)
  );
}

// Rótulo da coluna "Veiculação": o status traduzido e, quando só parte dos conjuntos está
// desligada, quantos ("Ativo · 1 de 3 conjuntos pausados").
export function rotuloVeiculacao(
  rotuloTraduzido: string | null,
  veiculacao: Pick<VeiculacaoCampanha, "status" | "conjuntos"> | null | undefined
): string | null {
  if (!rotuloTraduzido || !veiculacaoParcial(veiculacao)) return rotuloTraduzido;
  const { pausados, total } = veiculacao!.conjuntos!;
  return `${rotuloTraduzido} · ${pausados} de ${total} conjuntos pausados`;
}
