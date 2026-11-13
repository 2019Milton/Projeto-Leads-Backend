// Listagens da Graph API (Meta) vêm paginadas: sem `limit` são só 25 itens e o resto
// fica em `paging.next`. Um gestor com 49 contas de anúncios via só as 25 primeiras.

export const LIMITE_POR_PAGINA_GRAPH = 100;
export const MAXIMO_PAGINAS_GRAPH = 20;

export function comLimiteGraph(url: string, limite = LIMITE_POR_PAGINA_GRAPH): string {
  if (/[?&]limit=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}limit=${limite}`;
}

export type ListagemGraph<T> = {
  data: T[];
  // Erro da Meta; com `data` não vazio, a falha foi numa página seguinte.
  error: any | null;
  // Parou antes do fim (erro numa página seguinte ou limite de páginas).
  incompleto: boolean;
};

// Segue `paging.next` até o fim. Não registra URLs: as de `paging.next` levam o token.
export async function buscarTodasPaginasGraph<T = any>(
  urlInicial: string,
  opcoes: { maxPaginas?: number; fetchFn?: (url: string) => Promise<{ json(): Promise<any> }> } = {},
): Promise<ListagemGraph<T>> {
  const buscar = opcoes.fetchFn || ((url: string) => fetch(url));
  const maxPaginas = Math.max(1, opcoes.maxPaginas ?? MAXIMO_PAGINAS_GRAPH);
  const data: T[] = [];
  let proxima: string | null = comLimiteGraph(urlInicial);
  let paginas = 0;

  while (proxima && paginas < maxPaginas) {
    let resposta: any;
    try {
      resposta = await (await buscar(proxima)).json();
    } catch (err) {
      return { data, error: { message: String((err as any)?.message || err) }, incompleto: paginas > 0 };
    }

    if (resposta?.error) {
      return { data, error: resposta.error, incompleto: paginas > 0 };
    }

    if (Array.isArray(resposta?.data)) data.push(...resposta.data);
    paginas++;
    proxima = typeof resposta?.paging?.next === "string" && resposta.paging.next ? resposta.paging.next : null;
  }

  return { data, error: null, incompleto: Boolean(proxima) };
}
