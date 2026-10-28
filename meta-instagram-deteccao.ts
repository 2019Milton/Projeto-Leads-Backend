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
