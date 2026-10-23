// Percorre todas as paginas retornadas pelo Insights da Meta sem perder dias/campanhas.
// Funcao isolada para testar a paginacao sem chamadas reais a Graph API.
export interface PaginaInsightsMeta<T> {
  data?: T[];
  paging?: { next?: string };
  error?: { message?: string; code?: number };
}

export async function consultarInsightsMetaPaginados<T>(
  urlInicial: string,
  buscarPagina: (url: string) => Promise<PaginaInsightsMeta<T>>,
  limitePaginas = 100,
): Promise<{ data: T[]; paginas: number }> {
  const acumulado: T[] = [];
  const visitadas = new Set<string>();
  let proxima: string | undefined = urlInicial;
  let paginas = 0;

  while (proxima) {
    const url = new URL(proxima);
    if (url.protocol !== "https:" || url.hostname !== "graph.facebook.com" || url.port) {
      throw new Error("URL de paginacao de Insights Meta invalida");
    }
    if (visitadas.has(proxima)) throw new Error("Paginacao Meta repetida");
    if (paginas >= limitePaginas) throw new Error("Limite de paginas da Meta atingido; consulta incompleta");
    visitadas.add(proxima);

    const resposta = await buscarPagina(proxima);
    if (resposta?.error) {
      throw new Error("Insights Meta: " + (resposta.error.message || "erro na consulta"));
    }
    if (!Array.isArray(resposta?.data)) {
      throw new Error("Resposta de Insights Meta sem lista de dados");
    }
    acumulado.push(...resposta.data);
    paginas++;
    proxima = resposta.paging?.next || undefined;
  }

  return { data: acumulado, paginas };
}
