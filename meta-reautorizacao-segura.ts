/**
 * Renovacao do token Meta preservando configuracao e Instagram separado.
 * Nao remove registros existentes, campanhas ou contas de anuncios.
 */
export type ExecutarQueryMeta = (sql: string, params: unknown[]) =>
  Promise<{rows: Array<{id: number | string}>}>;
export async function salvarTokenMetaSemPerderVinculos(
  executar: ExecutarQueryMeta, usuarioId: number, token: string
): Promise<void> {
  if (!Number.isSafeInteger(usuarioId) || usuarioId <= 0 || !token) {
    throw new Error("Dados invalidos na reautorizacao Meta.");
  }
  const atualizada = await executar(
    `UPDATE meta_conexoes SET access_token = $1
     WHERE id = (
       SELECT id FROM meta_conexoes WHERE usuario_id = $2
       ORDER BY id DESC LIMIT 1
     ) RETURNING id`,
    [token, usuarioId]
  );
  if (atualizada.rows.length === 0) {
    await executar(
      "INSERT INTO meta_conexoes (usuario_id, access_token) VALUES ($1, $2) RETURNING id",
      [usuarioId, token]
    );
  }
}
