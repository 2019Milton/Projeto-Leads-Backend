/**
 * Remove somente o vinculo OAuth avulso do Instagram salvo pela Plataforma.
 * Nao remove a conexao Meta, a Pagina, a conta de anuncios nem os ativos da Meta.
 * O titular pode revogar o acesso externo na central de apps do Instagram.
 */
export const SQL_DESVINCULAR_INSTAGRAM_AVULSO = `
  UPDATE meta_conexoes
  SET instagram_id = NULL,
      instagram_username = NULL,
      instagram_profile_picture_url = NULL,
      instagram_token = NULL,
      instagram_conectado_em = NULL
  WHERE usuario_id = $1
    AND id = (
      SELECT id FROM meta_conexoes
      WHERE usuario_id = $1
      ORDER BY id DESC LIMIT 1
    )
    AND (instagram_token IS NOT NULL OR instagram_id IS NOT NULL)
  RETURNING id
`;

export async function desvincularInstagramAvulso(
  banco: { query: (sql: string, params: any[]) => Promise<{rows: any[]}> },
  usuarioId: number
): Promise<boolean> {
  if (!Number.isSafeInteger(usuarioId) || usuarioId <= 0)
    throw new Error("Usuario invalido para desconexao do Instagram.");
  const resultado = await banco.query(SQL_DESVINCULAR_INSTAGRAM_AVULSO, [usuarioId]);
  return Array.isArray(resultado.rows) && resultado.rows.length > 0;
}
