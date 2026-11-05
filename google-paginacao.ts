// Paginação das consultas ao Google Ads (googleAds:search).
//
// A API devolve no máximo 10 mil linhas por página e o restante só vem seguindo o
// nextPageToken. googleAdsQuery lia só a primeira página: numa conta grande, consultas por
// campanha x dia (desempenho anual, por exemplo) ficavam cortadas em silêncio e os números
// subiam menores do que eram, sem nenhum erro.
//
// Aqui só está a lógica de juntar as páginas (sem rede), para poder testar.

// 100 páginas = 1 milhão de linhas. Só existe para um token que nunca acaba não prender o
// servidor num laço infinito.
export const MAX_PAGINAS_GOOGLE_ADS = 100;

export type PaginaGoogleAds = { results?: any[]; nextPageToken?: string };

export async function juntarPaginasGoogleAds(
  buscarPagina: (pageToken: string | null) => Promise<PaginaGoogleAds>,
  opcoes: { maxPaginas?: number; aviso?: (mensagem: string) => void } = {}
): Promise<any[]> {
  const maxPaginas = opcoes.maxPaginas ?? MAX_PAGINAS_GOOGLE_ADS;
  const resultados: any[] = [];
  let token: string | null = null;

  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const dados: PaginaGoogleAds = await buscarPagina(token);
    if (Array.isArray(dados?.results)) resultados.push(...dados.results);

    const proximo = typeof dados?.nextPageToken === "string" && dados.nextPageToken ? dados.nextPageToken : null;
    if (!proximo) return resultados;

    // Token repetido = a API não está avançando; seguir só repetiria as mesmas linhas.
    if (proximo === token) {
      opcoes.aviso?.("AVISO GOOGLE ADS: nextPageToken repetido, paginação interrompida.");
      return resultados;
    }
    token = proximo;
  }

  opcoes.aviso?.(`AVISO GOOGLE ADS: consulta passou de ${maxPaginas} páginas; resultado parcial.`);
  return resultados;
}
