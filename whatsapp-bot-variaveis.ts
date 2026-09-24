// Marcador mantido no texto para compatibilidade com o editor de roteiros.
const CAPTURA = /\[CAPTURAR:nome\]/gi;

export function capturaNome(passo: any): boolean {
  return passo?.tipo === "pergunta" &&
    (passo.capturar_variavel === "nome" || /\[CAPTURAR:nome\]/i.test(passo.texto || ""));
}

export function normalizarNome(resposta: unknown): string | null {
  if (typeof resposta !== "string") return null;
  const nome = resposta.trim().replace(/^(?:meu nome [ée]|me chamo|eu sou|sou (?:o|a))\s+/i, "")
    .replace(/\s+/g, " ");
  if (nome.length < 2 || nome.length > 80 || nome.split(" ").length > 8) return null;
  if (!/^[\p{L}\p{M}]+(?:[ '\u2019-][\p{L}\p{M}]+)*$/u.test(nome)) return null;
  if (/^(sim|não|nao|ok|oi|olá|ola|bom dia|boa tarde|boa noite|não quero|nao quero)$/i.test(nome)) return null;
  return nome;
}

export function renderizarTextoBot(texto: unknown, variaveis: Record<string, unknown> = {}): string {
  const nome = normalizarNome(variaveis?.nome);
  return String(texto || "").replace(CAPTURA, "").replace(/\[nome\]/gi, () => nome || "você").trim();
}

// Uma única instrução SQL persiste a captura e atualiza somente o lead vinculado
// ao mesmo dono. O JSON permite adicionar outras variáveis sem novas colunas.
export async function salvarNomeBot(db: any, conversa: any, resposta: unknown): Promise<boolean> {
  const nome = normalizarNome(resposta);
  if (!nome) return false;
  const result = await db.query(`
    WITH captura AS (
      UPDATE whatsapp_conversas
      SET variaveis = COALESCE(variaveis, '{}'::jsonb) || jsonb_build_object('nome', $1::text),
          atualizado_em = NOW()
      WHERE id = $2 AND usuario_id = $3 AND status = 'aguardando_resposta'
        AND passo_atual = $4 AND roteiro_id IS NOT DISTINCT FROM $5
      RETURNING lead_id, usuario_id, variaveis
    ), lead_atualizado AS (
      UPDATE leads l SET nome = $1
      FROM captura c WHERE l.id = c.lead_id AND l.usuario_id = c.usuario_id
      RETURNING l.id
    )
    SELECT variaveis FROM captura`,
    [nome, conversa.id, conversa.usuario_id, conversa.passo_atual, conversa.roteiro_id ?? null]);
  if (!result.rows.length) return false;
  conversa.variaveis = result.rows[0].variaveis;
  return true;
}
