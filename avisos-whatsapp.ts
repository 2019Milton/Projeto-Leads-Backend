// Avisos que a plataforma manda por WhatsApp (número da plataforma, Z-API) e quem recebe cada um.
//
// O super admin escolhe os destinatários em Admin → Avisos por WhatsApp. Sem escolha salva para
// um usuário vale o padrão, que é o comportamento de antes do painel:
//   - avisos da conta (novo lead, lembretes, cobrança...) vão para o dono da conta;
//   - avisos da administração (suporte, saldo de IA) vão para os super admins.
// Usuário inativo não recebe nada. A chave "notificações de lead" que o próprio usuário liga em
// Configurações continua valendo para os avisos marcados com respeitaPreferenciaUsuario.
//
// Todo aviso passa por verificarAvisoWhatsApp antes de sair (index.ts e financeiro-lembretes.ts).
// Mensagens de atendimento a leads (WhatsApp oficial do corretor) não são avisos e ficam fora.

export type GrupoAvisoWhatsApp = "conta" | "administracao";

export type AvisoWhatsApp = {
  chave: string;
  nome: string;
  grupo: GrupoAvisoWhatsApp;
  quando: string;
  frequencia: string;
  respeitaPreferenciaUsuario: boolean;
};

export const AVISOS_WHATSAPP = [
  {
    chave: "novo_lead",
    nome: "Novo lead chegou",
    grupo: "conta",
    quando: "Cada lead novo: Meta, Google, TikTok, LinkedIn, Kwai, site, WhatsApp ou cadastro manual.",
    frequencia: "A cada lead",
    respeitaPreferenciaUsuario: true,
  },
  {
    chave: "lead_quente_voltou",
    nome: "Lead quente voltou a falar",
    grupo: "conta",
    quando: "Lead que já tinha avançado na conversa volta a escrever depois que o roteiro do bot mudou.",
    frequencia: "A cada retorno",
    respeitaPreferenciaUsuario: true,
  },
  {
    chave: "lembrete_contato_amanha",
    nome: "Lembrete de contato (amanhã)",
    grupo: "conta",
    quando: "Lead com data de contato marcada para amanhã.",
    frequencia: "Uma vez por lead, às 8h",
    respeitaPreferenciaUsuario: false,
  },
  {
    chave: "lembrete_contato_hoje",
    nome: "Lembrete de contato (hoje)",
    grupo: "conta",
    quando: "Lead com data de contato marcada para hoje.",
    frequencia: "Uma vez por lead, às 8h",
    respeitaPreferenciaUsuario: false,
  },
  {
    chave: "campanha_fim_amanha",
    nome: "Campanha termina amanhã",
    grupo: "conta",
    quando: "Campanha com data de término amanhã.",
    frequencia: "Uma vez por campanha, às 8h",
    respeitaPreferenciaUsuario: false,
  },
  {
    chave: "campanha_fim_hoje",
    nome: "Campanha termina hoje",
    grupo: "conta",
    quando: "Campanha com data de término hoje.",
    frequencia: "Uma vez por campanha, às 8h",
    respeitaPreferenciaUsuario: false,
  },
  {
    chave: "limite_gastos_meta",
    nome: "Limite de gastos da conta Meta",
    grupo: "conta",
    quando: "Pendência de pagamento, saldo pré-pago zerado ou gasto em 90% do limite da conta de anúncios.",
    frequencia: "No máximo 1 por dia",
    respeitaPreferenciaUsuario: false,
  },
  {
    chave: "resumo_semanal",
    nome: "Resumo semanal",
    grupo: "conta",
    quando: "Sexta às 16h, para quem tem o WhatsApp Bot conectado. Vai para o número do bot, não o do perfil.",
    frequencia: "Semanal",
    respeitaPreferenciaUsuario: true,
  },
  {
    chave: "financeiro_vence_amanha",
    nome: "Cobrança vence amanhã",
    grupo: "conta",
    quando: "Cobrança da plataforma aguardando pagamento que vence amanhã.",
    frequencia: "Uma vez por cobrança",
    respeitaPreferenciaUsuario: false,
  },
  {
    chave: "financeiro_vence_hoje",
    nome: "Cobrança vence hoje",
    grupo: "conta",
    quando: "Cobrança da plataforma aguardando pagamento que vence hoje.",
    frequencia: "Uma vez por cobrança",
    respeitaPreferenciaUsuario: false,
  },
  {
    chave: "financeiro_atraso",
    nome: "Cobrança em atraso",
    grupo: "conta",
    quando: "Cobrança vencida sem comprovante enviado.",
    frequencia: "Todo dia (9h às 21h) até enviar o comprovante",
    respeitaPreferenciaUsuario: false,
  },
  {
    chave: "suporte_nova_mensagem",
    nome: "Nova mensagem no suporte",
    grupo: "administracao",
    quando: "Cliente escreve no chat de suporte e ninguém do suporte está com a conversa aberta.",
    frequencia: "A cada mensagem",
    respeitaPreferenciaUsuario: false,
  },
  {
    chave: "ia_sem_credito",
    nome: "IA sem crédito",
    grupo: "administracao",
    quando: "OpenAI ou Anthropic recusa chamadas por falta de crédito.",
    frequencia: "No máximo a cada 6h por provedor",
    respeitaPreferenciaUsuario: false,
  },
  {
    chave: "ia_saldo_baixo",
    nome: "IA: saldo baixo",
    grupo: "administracao",
    quando: "Saldo estimado da OpenAI ou Anthropic abaixo do aviso configurado no painel de IA.",
    frequencia: "Uma vez por saldo informado",
    respeitaPreferenciaUsuario: false,
  },
  {
    chave: "ia_recarga_automatica",
    nome: "IA: recarga automática provável",
    grupo: "administracao",
    quando: "Saldo estimado chegou ao gatilho da recarga automática configurada no provedor.",
    frequencia: "A cada recarga estimada",
    respeitaPreferenciaUsuario: false,
  },
] as const satisfies readonly AvisoWhatsApp[];

export type ChaveAvisoWhatsApp = (typeof AVISOS_WHATSAPP)[number]["chave"];

export function avisoWhatsAppPorChave(chave: unknown): AvisoWhatsApp | null {
  return AVISOS_WHATSAPP.find((aviso) => aviso.chave === chave) ?? null;
}

export type UsuarioAvisoWhatsApp = {
  tipo: string | null;
  ativo: boolean | null;
  whatsapp: string | null;
  notif_whatsapp_lead: boolean | null;
};

export type MotivoAvisoWhatsApp =
  | "recebe"
  | "fora_do_padrao"
  | "desligado_no_painel"
  | "inativo"
  | "desligado_pelo_usuario"
  | "sem_whatsapp";

export function recebePorPadrao(aviso: AvisoWhatsApp, usuario: Pick<UsuarioAvisoWhatsApp, "tipo">): boolean {
  return aviso.grupo === "conta" ? true : usuario.tipo === "super_admin";
}

function soDigitos(valor: unknown): string {
  return String(valor || "").replace(/\D/g, "");
}

// escolha: o que o super admin marcou no painel (null = nunca mexeu, vale o padrão).
// telefoneDestino: só quando o aviso não vai para o WhatsApp do perfil (resumo semanal → número do bot).
export function decidirAvisoWhatsApp(
  aviso: AvisoWhatsApp,
  usuario: UsuarioAvisoWhatsApp,
  escolha: boolean | null,
  telefoneDestino?: string | null
): { envia: boolean; motivo: MotivoAvisoWhatsApp; marcado: boolean } {
  const marcado = escolha ?? recebePorPadrao(aviso, usuario);
  if (!marcado) {
    return { envia: false, marcado, motivo: escolha === false ? "desligado_no_painel" : "fora_do_padrao" };
  }
  if (usuario.ativo === false) return { envia: false, marcado, motivo: "inativo" };
  if (aviso.respeitaPreferenciaUsuario && usuario.notif_whatsapp_lead === false) {
    return { envia: false, marcado, motivo: "desligado_pelo_usuario" };
  }
  const telefone = telefoneDestino === undefined ? usuario.whatsapp : telefoneDestino;
  if (!soDigitos(telefone)) return { envia: false, marcado, motivo: "sem_whatsapp" };
  return { envia: true, marcado, motivo: "recebe" };
}

export function textoMotivoAvisoWhatsApp(motivo: MotivoAvisoWhatsApp): string {
  switch (motivo) {
    case "recebe": return "Recebe";
    case "fora_do_padrao": return "Não está entre os destinatários deste aviso.";
    case "desligado_no_painel": return "Este aviso foi desligado para a sua conta pelo administrador.";
    case "inativo": return "Conta inativa não recebe avisos.";
    case "desligado_pelo_usuario": return "As notificações no WhatsApp estão desligadas em Configurações.";
    case "sem_whatsapp": return "Nenhum número de WhatsApp cadastrado.";
  }
}

/* ---------- banco ---------- */

type Consulta = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const SQL_TABELAS_AVISOS_WHATSAPP = `
  -- Escolha do super admin por aviso × usuário. Sem linha = padrão (ver recebePorPadrao).
  CREATE TABLE IF NOT EXISTS whatsapp_avisos_destinatarios (
    aviso          TEXT NOT NULL,
    usuario_id     INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    recebe         BOOLEAN NOT NULL,
    atualizado_por INTEGER,
    atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (aviso, usuario_id)
  );

  -- Cada tentativa de envio (resultado 'enviado' ou 'erro'); alimenta a contagem do painel.
  CREATE TABLE IF NOT EXISTS whatsapp_avisos_envios (
    id         SERIAL PRIMARY KEY,
    aviso      TEXT NOT NULL,
    usuario_id INTEGER,
    resultado  TEXT NOT NULL,
    criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_whatsapp_avisos_envios_aviso
    ON whatsapp_avisos_envios(aviso, criado_em);
`;

const SQL_USUARIO_AVISO = `
  SELECT u.tipo, COALESCE(u.ativo, true) AS ativo, u.whatsapp, u.notif_whatsapp_lead, d.recebe AS escolha
  FROM usuarios u
  LEFT JOIN whatsapp_avisos_destinatarios d ON d.usuario_id = u.id AND d.aviso = $2
  WHERE u.id = $1
`;

export async function verificarAvisoWhatsApp(
  db: Consulta,
  chave: ChaveAvisoWhatsApp,
  usuarioId: number,
  telefoneDestino?: string | null
): Promise<{ envia: boolean; motivo: MotivoAvisoWhatsApp; telefone: string }> {
  const aviso = avisoWhatsAppPorChave(chave);
  if (!aviso) throw new Error(`Aviso de WhatsApp desconhecido: ${chave}`);
  const linha = (await db.query(SQL_USUARIO_AVISO, [usuarioId, chave])).rows[0];
  if (!linha) return { envia: false, motivo: "sem_whatsapp", telefone: "" };
  const escolha = typeof linha.escolha === "boolean" ? linha.escolha : null;
  const decisao = decidirAvisoWhatsApp(aviso, linha, escolha, telefoneDestino);
  const telefone = String((telefoneDestino === undefined ? linha.whatsapp : telefoneDestino) || "");
  return { envia: decisao.envia, motivo: decisao.motivo, telefone: decisao.envia ? telefone : "" };
}

// Destinatários de um aviso da administração: os marcados no painel e, sem escolha salva,
// os super admins. Cada um ainda passa por decidirAvisoWhatsApp (inativo, sem WhatsApp).
export async function destinatariosAvisoAdministracao(
  db: Consulta,
  chave: ChaveAvisoWhatsApp
): Promise<{ usuarioId: number; telefone: string }[]> {
  const aviso = avisoWhatsAppPorChave(chave);
  if (!aviso) throw new Error(`Aviso de WhatsApp desconhecido: ${chave}`);
  const linhas = (
    await db.query(
      `
      SELECT u.id, u.tipo, COALESCE(u.ativo, true) AS ativo, u.whatsapp, u.notif_whatsapp_lead, d.recebe AS escolha
      FROM usuarios u
      LEFT JOIN whatsapp_avisos_destinatarios d ON d.usuario_id = u.id AND d.aviso = $1
      WHERE d.recebe = true OR (d.recebe IS NULL AND u.tipo = 'super_admin')
      ORDER BY u.id
      `,
      [chave]
    )
  ).rows;
  return linhas
    .filter((linha) => decidirAvisoWhatsApp(aviso, linha, typeof linha.escolha === "boolean" ? linha.escolha : null).envia)
    .map((linha) => ({ usuarioId: Number(linha.id), telefone: String(linha.whatsapp) }));
}

export async function registrarEnvioAvisoWhatsApp(
  db: Consulta,
  chave: ChaveAvisoWhatsApp,
  usuarioId: number | null,
  enviado: boolean
) {
  try {
    await db.query(
      `INSERT INTO whatsapp_avisos_envios (aviso, usuario_id, resultado) VALUES ($1, $2, $3)`,
      [chave, usuarioId, enviado ? "enviado" : "erro"]
    );
  } catch (err: any) {
    console.error(`[aviso-whatsapp] erro ao registrar envio de ${chave}:`, err?.message || err);
  }
}

/* ---------- painel ---------- */

export type UsuarioPainelAvisos = UsuarioAvisoWhatsApp & {
  id: number;
  nome: string | null;
  sobrenome: string | null;
  email: string | null;
};

export type EscolhaAvisoWhatsApp = { aviso: string; usuario_id: number; recebe: boolean };

export type EnviosAvisoWhatsApp = {
  aviso: string;
  enviados: number;
  falhas: number;
  ultimo_envio_em: string | Date | null;
};

export function montarPainelAvisosWhatsApp(
  usuarios: UsuarioPainelAvisos[],
  escolhas: EscolhaAvisoWhatsApp[],
  envios: EnviosAvisoWhatsApp[]
) {
  const escolhaDe = new Map(escolhas.map((e) => [`${e.aviso}:${Number(e.usuario_id)}`, Boolean(e.recebe)]));
  const enviosDe = new Map(envios.map((e) => [e.aviso, e]));

  const avisos = AVISOS_WHATSAPP.map((aviso) => {
    const destinatarios = usuarios.map((usuario) => {
      const escolha = escolhaDe.get(`${aviso.chave}:${Number(usuario.id)}`);
      const decisao = decidirAvisoWhatsApp(aviso, usuario, escolha ?? null);
      return {
        usuario_id: Number(usuario.id),
        escolha: escolha ?? null,
        marcado: decisao.marcado,
        recebe: decisao.envia,
        motivo: decisao.motivo,
      };
    });
    const envio = enviosDe.get(aviso.chave);
    return {
      chave: aviso.chave,
      nome: aviso.nome,
      grupo: aviso.grupo,
      quando: aviso.quando,
      frequencia: aviso.frequencia,
      respeita_preferencia_usuario: aviso.respeitaPreferenciaUsuario,
      padrao: aviso.grupo === "conta" ? "Dono da conta" : "Super admins",
      recebem: destinatarios.filter((d) => d.recebe).length,
      personalizado: destinatarios.some((d) => d.escolha !== null),
      enviados_30d: Number(envio?.enviados || 0),
      falhas_30d: Number(envio?.falhas || 0),
      ultimo_envio_em: envio?.ultimo_envio_em ?? null,
      destinatarios,
    };
  });

  return {
    avisos,
    usuarios: usuarios.map((u) => ({
      id: Number(u.id),
      nome: [u.nome, u.sobrenome].map((p) => String(p || "").trim()).filter(Boolean).join(" ") || u.email || `Usuário ${u.id}`,
      email: u.email,
      tipo: u.tipo,
      ativo: u.ativo !== false,
      tem_whatsapp: Boolean(soDigitos(u.whatsapp)),
      notif_whatsapp_lead: u.notif_whatsapp_lead !== false,
    })),
  };
}

// Corpo do PUT /admin/avisos-whatsapp/:aviso. recebe null = volta ao padrão (apaga a escolha).
export function validarEscolhaAvisoWhatsApp(
  chave: unknown,
  corpo: any
): { aviso: AvisoWhatsApp; usuarioIds: number[]; recebe: boolean | null } | { erro: string } {
  const aviso = avisoWhatsAppPorChave(chave);
  if (!aviso) return { erro: "Aviso desconhecido" };
  const lista = corpo?.usuario_ids;
  if (!Array.isArray(lista) || !lista.length || lista.length > 1000) return { erro: "Informe os usuários" };
  const usuarioIds = [...new Set(lista.map((id: unknown) => Number(id)))];
  if (usuarioIds.some((id) => !Number.isInteger(id) || id <= 0)) return { erro: "Usuário inválido" };
  const recebe = corpo?.recebe;
  if (recebe !== true && recebe !== false && recebe !== null) return { erro: "Informe se recebe ou não" };
  return { aviso, usuarioIds, recebe };
}
