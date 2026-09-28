type Nicho = { id: number; nome: string; slug: string };
const normalizar = (s: unknown) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Só nomes explícitos ou uma opção de menu já apresentada. "Plano", "oi" ou
// CNPJ isolados não permitem adivinhar o interesse entre vários produtos.
export function escolherNichoWhatsApp(texto: string, nichos: Nicho[], menu: number[] = []): number | null {
  const t = normalizar(texto);
  if (/\b(nao|sem)\b/.test(t)) return null;
  if (/^\d{1,2}$/.test(t)) {
    const id = menu[Number(t) - 1];
    return nichos.some(n => n.id === id) ? id : null;
  }
  const encontrados = nichos.filter(n => {
    const nomes = [normalizar(n.nome), normalizar(n.slug)];
    if (n.slug === "saude") nomes.push("plano de saude", "planos de saude");
    return nomes.some(nome => nome.length >= 4 && (` ${t} `).includes(` ${nome} `));
  });
  return encontrados.length === 1 ? encontrados[0].id : null;
}

export function menuNichosWhatsApp(nichos: Nicho[]): string {
  return "Olá! Para direcionar seu atendimento, sobre qual assunto você quer falar?\n" +
    nichos.map((n, i) => `${i + 1}. ${n.nome}`).join("\n") +
    "\nResponda com o número ou o nome do assunto.";
}

// Não atribui campanha/rede de anúncio sem evidência. Serializa por conversa
// para duas mensagens recebidas juntas não criarem dois leads.
export async function garantirLeadWhatsAppSemOrigem(pool: any, conversaId: number, usuarioId: number, nome?: string | null) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows: [conversa] } = await db.query(
      "SELECT id, lead_id, telefone_cliente FROM whatsapp_conversas WHERE id=$1 AND usuario_id=$2 FOR UPDATE",
      [conversaId, usuarioId]
    );
    if (!conversa) throw new Error("Conversa não encontrada");
    if (conversa.lead_id) { await db.query("COMMIT"); return conversa.lead_id; }
    const numero = String(conversa.telefone_cliente || "").replace(/\D/g, "");
    if (!numero) throw new Error("Conversa sem telefone");
    const telefone = numero.startsWith("55") ? numero : `55${numero}`;
    // Mesmo critério de normalização usado no vínculo existente da aplicação.
    const { rows: existentes } = await db.query(`SELECT id FROM leads WHERE usuario_id=$1 AND
      (CASE WHEN regexp_replace(telefone,'[^0-9]','','g') LIKE '55%'
       THEN regexp_replace(telefone,'[^0-9]','','g')
       ELSE '55'||regexp_replace(telefone,'[^0-9]','','g') END)=$2 ORDER BY id LIMIT 1`, [usuarioId, telefone]);
    let leadId = existentes[0]?.id;
    if (!leadId) {
      const { rows: [lead] } = await db.query(`INSERT INTO leads
        (usuario_id,nome,telefone,origem,plataforma,status,campanha,criado_em)
        VALUES ($1,$2,$3,'whatsapp','whatsapp','novo','WhatsApp — origem não identificada',NOW()) RETURNING id`,
        [usuarioId, nome || "Contato WhatsApp", conversa.telefone_cliente]);
      leadId = lead.id;
    }
    await db.query("UPDATE whatsapp_conversas SET lead_id=$1 WHERE id=$2 AND usuario_id=$3", [leadId, conversaId, usuarioId]);
    await db.query("COMMIT");
    return leadId;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

export async function prepararTriagemWhatsApp(pool: any, conversaId: number, usuarioId: number, texto: string) {
  const { rows: [conversa] } = await pool.query(`SELECT wc.status,wc.variaveis,wc.referral,l.id AS lead_id,l.nicho_id,l.campanha_id
    FROM whatsapp_conversas wc JOIN leads l ON l.id=wc.lead_id AND l.usuario_id=wc.usuario_id
    WHERE wc.id=$1 AND wc.usuario_id=$2 AND l.origem='whatsapp'`, [conversaId, usuarioId]);
  if (!conversa || ["humano", "encerrada"].includes(conversa.status) || conversa.nicho_id || conversa.campanha_id || conversa.referral?.source_id) return null;
  const { rows: nichos } = await pool.query(`SELECT DISTINCT n.id,n.nome,n.slug
    FROM whatsapp_bot_config b JOIN nichos n ON n.id=b.nicho_id
    WHERE b.usuario_id=$1 AND b.ativo=TRUE AND jsonb_array_length(b.passos)>0 ORDER BY n.id`, [usuarioId]);
  if (!nichos.length) return null;
  const anterior = conversa.variaveis?.triagem_nichos;
  const menu = Array.isArray(anterior) ? anterior : [];
  const nicho = escolherNichoWhatsApp(texto, nichos, menu);
  if (nicho) {
    await pool.query("UPDATE leads SET nicho_id=$1 WHERE id=$2 AND usuario_id=$3 AND nicho_id IS NULL", [nicho, conversa.lead_id, usuarioId]);
    return { nicho_id: nicho, pergunta: null, opcoes: [] };
  }
  // Não repetir a pergunta em cada mensagem de uma sequência ou resposta incerta.
  return { nicho_id: null, pergunta: menu.length ? null : menuNichosWhatsApp(nichos), opcoes: nichos.map((n: Nicho) => n.id) };
}
