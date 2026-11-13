/**
 * Persiste respostas COMPLETAS de Lead Gen Form no CRM existente.
 * Serializa por usuário/conta/responseId usando PostgreSQL advisory lock
 * TRANSACTION-scoped: evita corrida entre cron, execução manual e futuro webhook.
 *
 * Chave e filtros no próprio SQL. Sem alteração de schema ou campanha.
 * Pool deverá ser "pg.Pool" da aplicação; NUNCA usar em um Client sem .connect().
 */
export async function inserirRespostaLinkedInUmaVez(pool, info) {
  const {
    usuarioId, contaAnunciosId, responseId, nome, email, telefone,
    campanha, respostasQualificacao, nichoId, submittedAt
  } = info ?? {};
  if (!Number.isSafeInteger(usuarioId) || usuarioId <= 0) throw new TypeError("usuarioId inválido");
  if (typeof contaAnunciosId !== "string" || !contaAnunciosId.trim()) throw new TypeError("contaAnunciosId obrigatório");
  if (typeof responseId !== "string" || !responseId.trim()) throw new TypeError("responseId obrigatório");
  if (!Array.isArray(respostasQualificacao)) throw new TypeError("respostasQualificacao inválidas");
  const timestamp = submittedAt == null ? null : Number(submittedAt);
  if (timestamp !== null && (!Number.isSafeInteger(timestamp) || timestamp <= 0)) {
    throw new TypeError("submittedAt inválido");
  }
  const db = await pool.connect();
  let activeTransaction = false;
  try {
    await db.query("BEGIN");
    activeTransaction = true;
    // Two hashtext args fit the pg_advisory_xact_lock(int,int) overload.
    // Hash collisions only serialize unrelated keys; the subsequent SELECT
    // checks the exact values and never treats a collision as a duplicate.
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [String(usuarioId), "linkedin:" + contaAnunciosId + ":" + responseId]);
    const existing = await db.query(
      `SELECT id FROM leads
       WHERE usuario_id=$1 AND plataforma='linkedin' AND conta_anuncios_id=$2
         AND lead_id=$3 LIMIT 1`,
      [usuarioId, contaAnunciosId, responseId]
    );
    if (existing.rows.length) {
      await db.query("COMMIT");
      activeTransaction = false;
      return null;
    }
    const inserted = await db.query(
      `INSERT INTO leads
         (usuario_id, lead_id, nome, email, telefone, campanha, conta_anuncios_id,
          origem, plataforma, status, respostas_qualificacao, nicho_id, criado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'linkedin','linkedin','novo',$8,$9,COALESCE(to_timestamp($10::bigint / 1000), NOW()))
       RETURNING id`,
      [usuarioId, responseId, nome || "Lead LinkedIn", email || "", telefone || "",
       campanha || "Campanha LinkedIn", contaAnunciosId,
       JSON.stringify(respostasQualificacao), nichoId ?? null, timestamp]
    );
    await db.query("COMMIT");
    activeTransaction = false;
    return inserted.rows[0]?.id ?? null;
  } catch (err) {
    if (activeTransaction) {
      try { await db.query("ROLLBACK"); } catch { /* preserve original error */ }
    }
    throw err;
  } finally {
    db.release();
  }
}
