import { Pool } from "pg";

const FUSO_BRASILIA = "America/Sao_Paulo";
const HORA_INICIO_ENVIO = 9;
const HORA_FIM_ENVIO = 20;
const INTERVALO_VERIFICACAO_MS = 60 * 60 * 1000;
const ATRASO_PRIMEIRA_VERIFICACAO_MS = 15 * 1000;

let iniciado = false;
let verificacaoEmAndamento = false;

const PIX_TIPO_LABEL: Record<string, string> = {
  cpf: "CPF",
  cnpj: "CNPJ",
  email: "E-mail",
  telefone: "Telefone",
  aleatoria: "Chave aleatória",
};

function hojeBrasiliaISO(): string {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: FUSO_BRASILIA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const valor = (tipo: string) =>
    partes.find((parte) => parte.type === tipo)?.value || "";

  return valor("year") + "-" + valor("month") + "-" + valor("day");
}

function horaBrasilia(): number {
  const hora = new Intl.DateTimeFormat("en-US", {
    timeZone: FUSO_BRASILIA,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date());

  return Number(hora);
}

function normalizarTelefoneWhatsApp(valor: unknown): string {
  const numero = String(valor || "").replace(/\D/g, "");
  if (!numero) return "";
  return numero.startsWith("55") ? numero : "55" + numero;
}

function mascararTelefone(valor: string): string {
  if (valor.length <= 6) return "***";
  return valor.slice(0, 4) + "****" + valor.slice(-4);
}

async function enviarWhatsAppFinanceiro(
  telefone: string,
  mensagem: string
): Promise<boolean> {
  const instanceId = Bun.env.ZAPI_INSTANCE_ID;
  const token = Bun.env.ZAPI_TOKEN;

  if (!instanceId || !token) {
    console.warn("[financeiro-whatsapp] ZAPI_INSTANCE_ID ou ZAPI_TOKEN não configurados");
    return false;
  }

  const phone = normalizarTelefoneWhatsApp(telefone);
  if (!phone) {
    console.warn("[financeiro-whatsapp] número vazio, envio cancelado");
    return false;
  }

  const clientToken = Bun.env.ZAPI_CLIENT_TOKEN || "";

  try {
    const res = await fetch(
      "https://api.z-api.io/instances/" +
        instanceId +
        "/token/" +
        token +
        "/send-text",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(clientToken ? { "Client-Token": clientToken } : {}),
        },
        body: JSON.stringify({ phone, message: mensagem }),
      }
    );

    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (!res.ok) {
      console.error(
        "[financeiro-whatsapp] erro " +
          res.status +
          " para " +
          mascararTelefone(phone) +
          ":",
        body
      );
      return false;
    }

    console.log(
      "[financeiro-whatsapp] lembrete enviado para " +
        mascararTelefone(phone)
    );
    return true;
  } catch (err) {
    console.error("[financeiro-whatsapp] exceção no envio:", err);
    return false;
  }
}

function formatarValorBRL(valor: unknown): string {
  return Number(valor || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function montarMensagem(linha: any): string {
  const diasAtraso = Number(linha.dias_atraso);
  const nomeCompleto = String(linha.nome || "").trim();
  const primeiroNome = nomeCompleto ? nomeCompleto.split(/\s+/)[0] : "";
  const saudacao = primeiroNome ? "Olá, " + primeiroNome + "!" : "Olá!";

  let titulo = "";
  let situacao = "";

  if (diasAtraso === -1) {
    titulo = "🔔 *Lembrete de vencimento*";
    situacao =
      "Sua cobrança da Plataforma de Leads vence *amanhã, " +
      linha.vencimento_formatado +
      "*.";
  } else if (diasAtraso === 0) {
    titulo = "⚠️ *Vencimento hoje*";
    situacao =
      "Sua cobrança da Plataforma de Leads vence *hoje, " +
      linha.vencimento_formatado +
      "*.";
  } else {
    titulo = "🚨 *Pagamento pendente*";
    situacao =
      "Sua cobrança da Plataforma de Leads venceu em *" +
      linha.vencimento_formatado +
      "* e está pendente há *" +
      diasAtraso +
      " " +
      (diasAtraso === 1 ? "dia" : "dias") +
      "*.";
  }

  const pixTipo = linha.pix_tipo
    ? PIX_TIPO_LABEL[String(linha.pix_tipo)] || String(linha.pix_tipo)
    : "";
  const pix = linha.pix_chave
    ? "\n🔑 *PIX" +
      (pixTipo ? " (" + pixTipo + ")" : "") +
      ":* " +
      String(linha.pix_chave)
    : "";

  const observacao = String(linha.observacao || "").trim();
  const obs = observacao ? "\n📝 " + observacao : "";

  return (
    titulo +
    "\n\n" +
    saudacao +
    " " +
    situacao +
    "\n\n💰 *Valor:* " +
    formatarValorBRL(linha.valor) +
    pix +
    obs +
    "\n\nApós o pagamento, envie o comprovante no menu *Financeiro* da plataforma. " +
    "Assim que o comprovante for enviado, estes lembretes param automaticamente."
  );
}

async function garantirEstrutura(db: Pool) {
  await db.query(
    "ALTER TABLE financeiro_lancamentos " +
      "ADD COLUMN IF NOT EXISTS ultimo_lembrete_whatsapp_data DATE"
  );
}

async function verificarLembretes(db: Pool) {
  if (verificacaoEmAndamento) return;

  const hora = horaBrasilia();
  if (!Number.isFinite(hora) || hora < HORA_INICIO_ENVIO || hora > HORA_FIM_ENVIO) {
    return;
  }

  verificacaoEmAndamento = true;
  const hoje = hojeBrasiliaISO();

  try {
    await garantirEstrutura(db);

    const sql =
      "SELECT " +
      "f.id, f.usuario_id, f.mes_referencia, f.valor, f.observacao, " +
      "f.pix_chave, f.pix_tipo, u.nome, u.whatsapp, " +
      "TO_CHAR(f.mes_referencia, 'DD/MM/YYYY') AS vencimento_formatado, " +
      "($1::date - f.mes_referencia)::int AS dias_atraso " +
      "FROM financeiro_lancamentos f " +
      "JOIN usuarios u ON u.id = f.usuario_id " +
      "WHERE f.status = 'aguardando_pagamento' " +
      "AND u.whatsapp IS NOT NULL " +
      "AND BTRIM(u.whatsapp) <> '' " +
      "AND f.mes_referencia <= ($1::date + INTERVAL '1 day')::date " +
      "AND f.ultimo_lembrete_whatsapp_data IS DISTINCT FROM $1::date " +
      "ORDER BY f.mes_referencia ASC, f.id ASC";

    const pendentes = await db.query(sql, [hoje]);

    for (const linha of pendentes.rows) {
      const diasAtraso = Number(linha.dias_atraso);
      if (!Number.isFinite(diasAtraso) || diasAtraso < -1) continue;

      const mensagem = montarMensagem(linha);
      const enviado = await enviarWhatsAppFinanceiro(
        String(linha.whatsapp || ""),
        mensagem
      );

      if (!enviado) continue;

      await db.query(
        "UPDATE financeiro_lancamentos " +
          "SET ultimo_lembrete_whatsapp_data = $1::date " +
          "WHERE id = $2",
        [hoje, linha.id]
      );

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (err) {
    console.error("[financeiro-whatsapp] erro ao verificar lembretes:", err);
  } finally {
    verificacaoEmAndamento = false;
  }
}

export function iniciarLembretesFinanceiroWhatsApp() {
  if (iniciado || Bun.env.FINANCEIRO_LEMBRETES_WHATSAPP === "0") return;
  iniciado = true;

  const databaseUrl = Bun.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn("[financeiro-whatsapp] DATABASE_URL não configurada");
    return;
  }

  const db = new Pool({
    connectionString: databaseUrl,
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  const executar = () => {
    void verificarLembretes(db);
  };

  setTimeout(executar, 30 * 1000);
  setInterval(executar, INTERVALO_VERIFICACAO_MS);
  console.log(
    "[financeiro-whatsapp] lembretes ativos: D-1, D0 e diário após vencimento"
  );
}

iniciarLembretesFinanceiroWhatsApp();
