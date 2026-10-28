/** Seleciona identidade de anuncios apenas quando ha evidencia nao ambigua. */
export type InstagramIdentidade = { id: string | number; username?: string | null; profile_picture_url?: string | null };
export function escolherInstagramDaContaAnuncios(
  contas: InstagramIdentidade[], detectado: InstagramIdentidade | null
): InstagramIdentidade | null {
  const validas = contas.filter(c => c && /^\d+$/.test(String(c.id ?? "")));
  const unicas = [...new Map(validas.map(c => [String(c.id), c])).values()];
  if (unicas.length === 1) return unicas[0];
  if (unicas.length > 1 && detectado?.id) {
    return unicas.find(c => String(c.id) === String(detectado.id)) || null;
  }
  return null;
}

/** Page API: business link preferido, connected link como fallback. */
export function extrairInstagramVinculadoPagina(
  dados: Record<string, any>
): InstagramIdentidade | null {
  const perfis = [dados?.instagram_business_account, dados?.connected_instagram_account];
  for (const perfil of perfis) {
    if (perfil && /^\d+$/.test(String(perfil.id ?? ""))) {
      return {
        id: String(perfil.id),
        username: typeof perfil.username === "string" ? perfil.username : null,
        profile_picture_url: typeof perfil.profile_picture_url === "string" ? perfil.profile_picture_url : null
      };
    }
  }
  return null;
}
