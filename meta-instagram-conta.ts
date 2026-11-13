// Instagram da conta de anúncios escolhida. Candidatos: os liberados para a conta
// (act_/instagram_accounts) e os vinculados às Páginas que ela pode promover
// (act_/promote_pages). Antes a plataforma mostrava o primeiro Instagram entre
// TODAS as Páginas do usuário: um gestor com 46 Páginas de clientes via, na conta
// da TVC Travel, o Instagram de outro cliente (@rhamasaude).

export type InstagramCandidato = {
  id: string;
  username: string | null;
  profile_picture_url: string | null;
  // Aparece em act_/instagram_accounts: a Meta aceita como anunciante desta conta.
  liberado_na_conta: boolean;
  // Páginas desta conta de anúncios que têm este Instagram vinculado.
  paginas: { id: string; name: string | null }[];
};

const idValido = (valor: unknown) => /^\d+$/.test(String(valor ?? ""));
const textoOuNulo = (valor: unknown) => (typeof valor === "string" && valor.trim() ? valor.trim() : null);

export function normalizarIdContaAnunciosMeta(valor: unknown): string {
  return String(valor ?? "").trim().replace(/^act_/, "");
}

export function instagramVinculadoPagina(pagina: any): { id: string; username: string | null; profile_picture_url: string | null } | null {
  const ig = pagina?.instagram_business_account || pagina?.instagram || pagina?.connected_instagram_account;
  if (!ig || !idValido(ig.id)) return null;
  return { id: String(ig.id), username: textoOuNulo(ig.username), profile_picture_url: textoOuNulo(ig.profile_picture_url) };
}

export function montarCandidatosInstagramConta(entrada: {
  autorizados: unknown;
  paginasDaConta: unknown;
}): InstagramCandidato[] {
  const mapa = new Map<string, InstagramCandidato>();

  for (const conta of Array.isArray(entrada.autorizados) ? entrada.autorizados : []) {
    if (!idValido((conta as any)?.id)) continue;
    const id = String((conta as any).id);
    const atual = mapa.get(id);
    mapa.set(id, {
      id,
      username: atual?.username || textoOuNulo((conta as any).username),
      profile_picture_url: atual?.profile_picture_url || textoOuNulo((conta as any).profile_picture_url),
      liberado_na_conta: true,
      paginas: atual?.paginas || [],
    });
  }

  for (const pagina of Array.isArray(entrada.paginasDaConta) ? entrada.paginasDaConta : []) {
    const ig = instagramVinculadoPagina(pagina);
    if (!ig) continue;
    const atual = mapa.get(ig.id) || {
      id: ig.id, username: null, profile_picture_url: null, liberado_na_conta: false, paginas: [],
    };
    atual.username = atual.username || ig.username;
    atual.profile_picture_url = atual.profile_picture_url || ig.profile_picture_url;
    const paginaId = String((pagina as any)?.id ?? "");
    if (idValido(paginaId) && !atual.paginas.some((p) => p.id === paginaId)) {
      atual.paginas.push({ id: paginaId, name: textoOuNulo((pagina as any)?.name) });
    }
    mapa.set(ig.id, atual);
  }

  return [...mapa.values()].sort(
    (a, b) =>
      Number(b.liberado_na_conta) - Number(a.liberado_na_conta) ||
      String(a.username || a.id).localeCompare(String(b.username || b.id)),
  );
}

// Escolha salva (se ainda for candidata) > único candidato > único liberado.
// Com mais de um e nenhuma escolha, não adivinha: pede para o usuário escolher.
export function escolherInstagramParaConta(
  candidatos: InstagramCandidato[],
  escolhidoId: unknown,
): { instagram: InstagramCandidato | null; selecao_pendente: boolean } {
  const lista = Array.isArray(candidatos) ? candidatos : [];
  const escolhido = idValido(escolhidoId) ? lista.find((c) => c.id === String(escolhidoId)) : undefined;
  if (escolhido) return { instagram: escolhido, selecao_pendente: false };
  if (lista.length === 1) return { instagram: lista[0], selecao_pendente: false };
  const liberados = lista.filter((c) => c.liberado_na_conta);
  if (liberados.length === 1) return { instagram: liberados[0], selecao_pendente: false };
  return { instagram: null, selecao_pendente: lista.length > 1 };
}

// A escolha vale só para a conta de anúncios em que foi feita.
export function escolhaInstagramSalva(conexao: any, contaAnunciosId: unknown): string | null {
  const conta = normalizarIdContaAnunciosMeta(conexao?.instagram_anuncios_conta);
  if (!conta || conta !== normalizarIdContaAnunciosMeta(contaAnunciosId)) return null;
  return idValido(conexao?.instagram_anuncios_id) ? String(conexao.instagram_anuncios_id) : null;
}

// Páginas que a conta de anúncios pode promover vêm primeiro (a primeira é a que
// aparece no status e vem marcada no formulário de campanha). Sem a lista da conta
// (promote_pages falhou), mantém a ordem original e não marca nada.
export function ordenarPaginasPelaConta<T extends { id?: unknown }>(
  paginas: T[],
  idsDaConta: unknown[] | null,
): (T & { da_conta_anuncios?: boolean })[] {
  if (!Array.isArray(paginas)) return [];
  if (!Array.isArray(idsDaConta)) return paginas;
  const ids = new Set(idsDaConta.map((id) => String(id)));
  return paginas
    .map((pagina, indice) => ({ pagina: { ...pagina, da_conta_anuncios: ids.has(String(pagina?.id ?? "")) }, indice }))
    .sort((a, b) => Number(b.pagina.da_conta_anuncios) - Number(a.pagina.da_conta_anuncios) || a.indice - b.indice)
    .map((item) => item.pagina);
}
