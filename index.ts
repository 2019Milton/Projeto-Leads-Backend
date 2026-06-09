import { Hono } from "hono@4";
import { cors } from "hono/cors";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const app = new Hono();

const DEFAULT_TOKEN_SECRET = "troque-esta-chave-em-producao";

const syncEmAndamento = new Set<number>();

const TOKEN_SECRET =
  Bun.env.JWT_SECRET ||
  Bun.env.AUTH_SECRET ||
  Bun.env.SESSION_SECRET ||
  DEFAULT_TOKEN_SECRET;

const EXECUCAO_PRODUCAO =
  Bun.env.NODE_ENV === "production" ||
  Boolean(Bun.env.RAILWAY_ENVIRONMENT);

const TOKEN_TTL_SECONDS =
  Number(Bun.env.TOKEN_TTL_SECONDS) ||
  60 * 60 * 24 * 7;

const RESET_PASSWORD_TTL_MINUTES =
  Number(Bun.env.RESET_PASSWORD_TTL_MINUTES) ||
  30;

const META_OAUTH_STATE_TTL_MINUTES =
  Number(Bun.env.META_OAUTH_STATE_TTL_MINUTES) ||
  10;

const RESEND_FROM_EMAIL =
  Bun.env.RESEND_FROM_EMAIL ||
  Bun.env.RESEND_FROM ||
  "Plataforma de Leads <onboarding@resend.dev>";

const SENHA_FORTE =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#._-]).{8,}$/;

const PLANOS_PLATAFORMA = [
  "bronze",
  "prata",
  "ouro"
] as const;

type PlanoPlataforma =
  typeof PLANOS_PLATAFORMA[number];

const RECURSOS_POR_PLANO = {
  bronze: {
    machine_learning_leads: false,
    ia_leads: false,
    ia_assistente_comercial: false,
    ia_analise_campanhas: false,
    ia_whatsapp: false
  },
  prata: {
    machine_learning_leads: true,
    ia_leads: false,
    ia_assistente_comercial: false,
    ia_analise_campanhas: false,
    ia_whatsapp: false
  },
  ouro: {
    machine_learning_leads: true,
    ia_leads: true,
    ia_assistente_comercial: true,
    ia_analise_campanhas: true,
    ia_whatsapp: true
  }
} satisfies Record<PlanoPlataforma, Record<string, boolean>>;

function normalizarPlano(value: unknown): PlanoPlataforma {
  const plano =
    String(value ?? "")
      .trim()
      .toLowerCase() as PlanoPlataforma;

  return PLANOS_PLATAFORMA.includes(plano)
    ? plano
    : "bronze";
}

function obterRecursosPlano(
  planoInformado: unknown
) {
  const plano = normalizarPlano(planoInformado);

  return Object.fromEntries(
    Object.entries(RECURSOS_POR_PLANO[plano])
      .map(([recurso, habilitado]) => [
        recurso,
        habilitado
      ])
  );
}

function usuarioTemRecurso(
  user: any,
  recurso: keyof typeof RECURSOS_POR_PLANO.bronze
) {
  return Boolean(
    RECURSOS_POR_PLANO[
      normalizarPlano(user?.plano)
    ][recurso]
  );
}

function usuarioPodeOperarConta(
  user: any,
  usuarioId: unknown
) {
  return (
    user?.tipo === "super_admin" ||
    Number(user?.id) === Number(usuarioId)
  );
}

function resolverUsuarioIdOperacao(
  user: any,
  usuarioIdInformado: unknown
) {
  const usuarioId =
    Number(usuarioIdInformado || user?.id);

  if (
    !Number.isFinite(usuarioId) ||
    usuarioId <= 0 ||
    !usuarioPodeOperarConta(user, usuarioId)
  ) {
    return null;
  }

  return usuarioId;
}

function negarAcessoConta(c: any) {
  return c.json({
    error: "Acesso negado para esta conta"
  }, 403);
}

const rateLimitMemoria =
  new Map<string, { total: number; expiraEm: number }>();

function obterIpRequisicao(c: any) {
  return String(
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip") ||
    c.req.header("x-forwarded-for") ||
    "ip-desconhecido"
  )
    .split(",")[0]
    .trim();
}

function verificarRateLimit(
  chave: string,
  limite: number,
  janelaMs: number
) {
  const agora = Date.now();
  const atual =
    rateLimitMemoria.get(chave);

  if (!atual || atual.expiraEm <= agora) {
    rateLimitMemoria.set(chave, {
      total: 1,
      expiraEm: agora + janelaMs
    });
    return {
      permitido: true,
      retryAfter: 0
    };
  }

  if (atual.total >= limite) {
    return {
      permitido: false,
      retryAfter: Math.ceil((atual.expiraEm - agora) / 1000)
    };
  }

  atual.total += 1;
  rateLimitMemoria.set(chave, atual);

  if (rateLimitMemoria.size > 5000) {
    for (const [itemChave, item] of rateLimitMemoria.entries()) {
      if (item.expiraEm <= agora) {
        rateLimitMemoria.delete(itemChave);
      }
    }
  }

  return {
    permitido: true,
    retryAfter: 0
  };
}

function limitarRequisicao(
  c: any,
  escopo: string,
  limite: number,
  janelaMs: number
) {
  const rateLimit = verificarRateLimit(
    `${escopo}:${obterIpRequisicao(c)}`,
    limite,
    janelaMs
  );

  if (rateLimit.permitido) {
    return null;
  }

  c.header(
    "Retry-After",
    String(rateLimit.retryAfter)
  );

  return c.json({
    error: "Muitas tentativas. Tente novamente em instantes."
  }, 429);
}

function validarAssinaturaMetaWebhook(
  assinatura: string | null,
  corpo: string
) {
  const appSecret = Bun.env.META_APP_SECRET;

  if (!appSecret) {
    if (EXECUCAO_PRODUCAO) {
      console.error(
        "META_APP_SECRET nao configurado; webhook Meta rejeitado."
      );
      return false;
    }

    console.warn(
      "META_APP_SECRET nao configurado; webhook Meta aceito apenas fora de producao."
    );
    return true;
  }

  if (!assinatura?.startsWith("sha256=")) {
    return false;
  }

  const esperada =
    "sha256=" +
    createHmac("sha256", appSecret)
      .update(corpo)
      .digest("hex");

  const recebidaBuffer =
    Buffer.from(assinatura);

  const esperadaBuffer =
    Buffer.from(esperada);

  return (
    recebidaBuffer.length === esperadaBuffer.length &&
    timingSafeEqual(recebidaBuffer, esperadaBuffer)
  );
}

if (TOKEN_SECRET === DEFAULT_TOKEN_SECRET && EXECUCAO_PRODUCAO) {
  throw new Error(
    "JWT_SECRET nao configurado em producao. Defina uma chave forte no Railway."
  );
}

if (TOKEN_SECRET === DEFAULT_TOKEN_SECRET) {
  console.warn(
    "JWT_SECRET nao configurado. Defina essa variavel no Railway em producao."
  );
}

const allowedOrigins = new Set(
  [
    Bun.env.FRONTEND_URL,
    Bun.env.VERCEL_URL ? `https://${Bun.env.VERCEL_URL}` : null,
    "https://plataformadeleads.com.br",
    "https://www.plataformadeleads.com.br",
    "https://projeto-leads-snowy.vercel.app"
  ].filter(Boolean) as string[]
);

function resolverOrigemCors(origin: string) {
  if (!origin) {
    return "*";
  }

  if (
    allowedOrigins.has(origin) ||
    (
      Bun.env.ALLOW_VERCEL_PREVIEWS === "true" &&
      origin.endsWith(".vercel.app")
    )
  ) {
    return origin;
  }

  return "";
}

function base64Url(input: Buffer) {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function limparCampoToken(value: unknown) {
  return String(value ?? "").replace(/:/g, " ");
}

function assinarPayload(payload: string) {
  return base64Url(
    createHmac("sha256", TOKEN_SECRET)
      .update(payload)
      .digest()
  );
}

function compararAssinatura(
  recebida: string,
  esperada: string
) {
  const a = Buffer.from(recebida);
  const b = Buffer.from(esperada);

  return (
    a.length === b.length &&
    timingSafeEqual(a, b)
  );
}

function criarTokenUsuario(user: any) {
  const expiraEm =
    Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;

  const payload = [
    user.id,
    user.email,
    user.tipo,
    user.nome || "",
    user.sobrenome || "",
    normalizarPlano(user.plano),
    expiraEm
  ].map(limparCampoToken).join(":");

  const assinatura = assinarPayload(payload);

  return btoa(`${payload}:${assinatura}`);
}

function decodificarTokenUsuario(token: string) {
  const decoded = atob(token);
  const partes = decoded.split(":");

  if (partes.length < 3) {
    return null;
  }

  const [id, email, tipo] = partes;

  if (!id || !email) {
    return null;
  }

  const tokenAssinadoNovo =
    partes.length >= 8;

  const tokenAssinadoLegado =
    partes.length >= 7;

  if (!tokenAssinadoNovo && !tokenAssinadoLegado) {
    return null;
  }

  const indiceExpiracao =
    tokenAssinadoNovo ? 6 : 5;

  const indiceAssinatura =
    tokenAssinadoNovo ? 7 : 6;

  const payload =
    partes.slice(0, indiceExpiracao + 1).join(":");

  const expiraEm =
    Number(partes[indiceExpiracao]);

  const assinatura =
    partes[indiceAssinatura];

  const assinaturaEsperada = assinarPayload(payload);

  if (
    !assinatura ||
    !compararAssinatura(assinatura, assinaturaEsperada)
  ) {
    return null;
  }

  if (!Number.isFinite(expiraEm) || expiraEm < Date.now() / 1000) {
    return null;
  }

  return {
    id: Number(id),
    email,
    tipo,
    nome: partes[3] || "",
    sobrenome: partes[4] || "",
    plano: tokenAssinadoNovo
      ? normalizarPlano(partes[5])
      : "bronze"
  };
}

function senhaPareceHash(senhaSalva: string | null | undefined) {
  return Boolean(
    senhaSalva &&
    /^\$2[aby]\$/.test(senhaSalva)
  );
}

async function gerarHashSenha(senha: string) {
  return bcrypt.hash(senha, 12);
}

function gerarTokenResetSenha() {
  return base64Url(randomBytes(32));
}

function hashTokenResetSenha(token: string) {
  return assinarPayload(`password-reset:${token}`);
}

function gerarMetaOAuthState() {
  return base64Url(randomBytes(32));
}

function hashMetaOAuthState(state: string) {
  return assinarPayload(`meta-oauth-state:${state}`);
}

async function buscarResetTokenValido(token: string) {
  const tokenHash = hashTokenResetSenha(token);

  const reset = await client.query(
    `
    SELECT
      prt.id,
      prt.usuario_id,
      prt.expira_em
    FROM password_reset_tokens prt
    INNER JOIN usuarios u
      ON u.id = prt.usuario_id
    WHERE prt.token_hash = $1
    AND prt.usado_em IS NULL
    AND prt.expira_em > NOW()
    AND COALESCE(u.ativo, true) = true
    LIMIT 1
    `,
    [tokenHash]
  );

  return reset.rows[0] || null;
}

function obterFrontendUrl() {
  return (
    Bun.env.FRONTEND_URL ||
    "https://plataformadeleads.com.br"
  ).replace(/\/+$/g, "");
}

function textoOpcional(value: unknown) {
  return String(value ?? "").trim();
}

function numeroOpcional(value: unknown) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {
    return null;
  }

  const numero = Number(value);

  return Number.isFinite(numero)
    ? numero
    : null;
}

function listaOpcional(value: unknown) {
  return Array.isArray(value)
    ? value
        .map(item => textoOpcional(item))
        .filter(Boolean)
    : [];
}

async function listarPaginasComInstagram(
  token: string
) {
  const pages = await fetch(
    `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,instagram_business_account{id,username,profile_picture_url}&access_token=${token}`
  ).then(r => r.json());

  return Array.isArray(pages.data)
    ? pages.data.map((pagina: any) => ({
        ...pagina,
        instagram:
          pagina.instagram_business_account
            ? {
                id:
                  pagina.instagram_business_account.id ||
                  null,
                username:
                  pagina.instagram_business_account.username ||
                  null,
                profile_picture_url:
                  pagina.instagram_business_account.profile_picture_url ||
                  null
              }
            : null
      }))
    : [];
}

function urlOpcional(value: unknown, fallback: string) {
  const url = textoOpcional(value);

  if (!url) {
    return fallback;
  }

  try {
    const parsed = new URL(url);

    if (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:"
    ) {
      return url;
    }
  } catch {}

  return fallback;
}

function montarTargetingMeta(avancadas: any) {
  const pais =
    textoOpcional(avancadas?.pais)
      .toUpperCase()
      .slice(0, 2) || "BR";

  const latitude =
    numeroOpcional(avancadas?.latitude);

  const longitude =
    numeroOpcional(avancadas?.longitude);

  const raio =
    numeroOpcional(avancadas?.raio);

  const targeting: any = {
    geo_locations: {
      countries: [pais],
      location_types: [
        "home",
        "recent"
      ]
    }
  };

  if (
    latitude !== null &&
    longitude !== null &&
    raio !== null
  ) {
    targeting.geo_locations = {
      custom_locations: [
        {
          latitude,
          longitude,
          radius: raio,
          distance_unit: "kilometer"
        }
      ],
      location_types: [
        "home",
        "recent"
      ]
    };
  }

  const idadeMin =
    numeroOpcional(avancadas?.idade_min);

  const idadeMax =
    numeroOpcional(avancadas?.idade_max);

  if (idadeMin !== null) {
    targeting.age_min =
      Math.max(18, Math.min(65, idadeMin));
  }

  if (idadeMax !== null) {
    targeting.age_max =
      Math.max(18, Math.min(65, idadeMax));
  }

  const genero =
    numeroOpcional(avancadas?.genero);

  if (genero === 1 || genero === 2) {
    targeting.genders = [genero];
  }

  const interesses =
    Array.isArray(avancadas?.interesses_detalhados)
      ? avancadas.interesses_detalhados
          .map((interesse: any) => ({
            id: textoOpcional(interesse?.id),
            name: textoOpcional(interesse?.nome || interesse?.name)
          }))
          .filter((interesse: any) => interesse.id && interesse.name)
          .slice(0, 25)
      : [];

  if (interesses.length) {
    targeting.flexible_spec = [
      {
        interests: interesses
      }
    ];
  }

  const plataformas =
    listaOpcional(avancadas?.plataformas);

  const facebookPositions =
    listaOpcional(avancadas?.facebook_positions);

  if (
    facebookPositions.length &&
    !plataformas.includes("facebook")
  ) {
    plataformas.push("facebook");
  }

  if (facebookPositions.length) {
    targeting.facebook_positions = facebookPositions;
  }

  const instagramPositions =
    listaOpcional(avancadas?.instagram_positions);

  if (
    instagramPositions.length &&
    !plataformas.includes("instagram")
  ) {
    plataformas.push("instagram");
  }

  if (instagramPositions.length) {
    targeting.instagram_positions = instagramPositions;
  }

  if (plataformas.length) {
    targeting.publisher_platforms = plataformas;
  }

  const dispositivos =
    listaOpcional(avancadas?.dispositivos);

  if (dispositivos.length) {
    targeting.device_platforms = dispositivos;
  }

  if (avancadas?.advantage_audience) {
    targeting.targeting_automation = {
      advantage_audience: 1
    };
  }

  return targeting;
}

async function enviarEmailResetSenha(
  email: string,
  nome: string | null,
  resetUrl: string
) {
  if (!Bun.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY nao configurada");
  }

  const primeiroNome =
    nome?.trim() || "tudo bem";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${Bun.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: email,
      subject: "Troca de senha - Plataforma de Leads",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">
          <h2>Troca de senha</h2>
          <p>Olá, ${primeiroNome}.</p>
          <p>Recebemos uma solicitação para trocar a senha da sua conta.</p>
          <p>
            <a href="${resetUrl}" style="display:inline-block;background:#2563eb;color:white;padding:12px 18px;border-radius:8px;text-decoration:none">
              Criar nova senha
            </a>
          </p>
          <p>Esse link expira em ${RESET_PASSWORD_TTL_MINUTES} minutos.</p>
          <p>Se você não solicitou essa troca, ignore este email.</p>
        </div>
      `
    })
  });

  if (!res.ok) {
    const detalhe = await res.text();
    console.error(
      "RESEND RESET EMAIL ERROR:",
      detalhe
    );

    throw new Error("RESEND_EMAIL_SEND_FAILED");
  }
}

async function senhaConfere(
  senhaInformada: string,
  senhaSalva: string | null | undefined
) {
  if (!senhaSalva) {
    return false;
  }

  if (senhaPareceHash(senhaSalva)) {
    return bcrypt.compare(senhaInformada, senhaSalva);
  }

  return senhaInformada === senhaSalva;
}

async function atualizarSenhaLegadaSePreciso(
  usuarioId: number,
  senhaInformada: string,
  senhaSalva: string | null | undefined
) {
  if (
    senhaSalva &&
    !senhaPareceHash(senhaSalva) &&
    senhaInformada === senhaSalva
  ) {
    await client.query(
      "UPDATE usuarios SET senha = $1 WHERE id = $2",
      [await gerarHashSenha(senhaInformada), usuarioId]
    );
  }
}

async function senhaJaFoiUsadaRecentemente(
  usuarioId: number,
  novaSenha: string
) {
  const result = await client.query(
    `
    SELECT senha_hash
    FROM (
      SELECT senha AS senha_hash, NOW() AS criado_em
      FROM usuarios
      WHERE id = $1
      AND senha IS NOT NULL

      UNION ALL

      SELECT senha_hash, criado_em
      FROM password_history
      WHERE usuario_id = $1
    ) senhas
    WHERE senha_hash IS NOT NULL
    ORDER BY criado_em DESC
    LIMIT 10
    `,
    [usuarioId]
  );

  for (const row of result.rows) {
    if (await senhaConfere(novaSenha, row.senha_hash)) {
      return true;
    }
  }

  return false;
}

async function registrarSenhaAnterior(
  db: any,
  usuarioId: number,
  senhaHash: string | null | undefined
) {
  if (!senhaHash) return;

  await db.query(
    `
    INSERT INTO password_history (usuario_id, senha_hash)
    VALUES ($1, $2)
    `,
    [usuarioId, senhaHash]
  );

  await db.query(
    `
    DELETE FROM password_history
    WHERE id IN (
      SELECT id
      FROM password_history
      WHERE usuario_id = $1
      ORDER BY criado_em DESC, id DESC
      OFFSET 10
    )
    `,
    [usuarioId]
  );
}

// 🔥 SCORE AUTOMÁTICO
function calcularScoreLead(
  lead: any
) {

  // 🔥 SCORE MANUAL
  if (lead.score_manual) {

    return {
      score: lead.score_manual,
      pontos: null,
      base: [
        "Score definido manualmente"
      ]
    };
  }

  let pontos = 0;

  const base = [];

  const respostasTexto =
    textoRespostasQualificacao(lead)
      .toLowerCase();

  const textoComercial =
    [
      lead.campanha,
      lead.observacao,
      respostasTexto
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

  const textoQualificacao =
    [
      lead.observacao,
      respostasTexto
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

  // 🆕 Lead novo
  pontos += 10;
  base.push("+10 Lead recém capturado");

  if (lead.telefone) {
    pontos += 10;
    base.push("+10 Telefone informado");
  }

  if (lead.email) {
    pontos += 5;
    base.push("+5 Email informado");
  }

  if (
    textoComercial.includes("visita") ||
    textoComercial.includes("agendar") ||
    textoComercial.includes("financiamento") ||
    textoComercial.includes("simula��o") ||
    textoComercial.includes("simulacao") ||
    textoComercial.includes("entrada") ||
    textoComercial.includes("comprar") ||
    textoComercial.includes("compra") ||
    textoComercial.includes("orcamento") ||
    textoComercial.includes("or�amento") ||
    textoComercial.includes("valor") ||
    textoComercial.includes("parcela")
  ) {

    pontos += 30;
    base.push("+30 Dados indicam inten��o forte");
  }

  if (
    textoComercial.includes("urgente") ||
    textoComercial.includes("rapido") ||
    textoComercial.includes("r�pido") ||
    textoComercial.includes("hoje") ||
    textoComercial.includes("essa semana")
  ) {

    pontos += 20;
    base.push("+20 Lead demonstra urg�ncia");
  }

  if (
    respostasTexto.includes("renda") ||
    respostasTexto.includes("credito") ||
    respostasTexto.includes("cr�dito") ||
    respostasTexto.includes("fgts") ||
    respostasTexto.includes("pre aprovado") ||
    respostasTexto.includes("pr� aprovado")
  ) {

    pontos += 15;
    base.push("+15 Respostas qualificadoras indicam preparo financeiro");
  }

  if (
    textoQualificacao.includes("n�o responde") ||
    textoQualificacao.includes("nao responde") ||
    textoQualificacao.includes("sem interesse") ||
    textoQualificacao.includes("desistiu") ||
    textoQualificacao.includes("curioso") ||
    textoQualificacao.includes("pesquisando")
  ) {

    pontos -= 30;
    base.push("-30 Dados indicam baixo interesse");
  }
  // 🔄 Lead repetido
  if (lead.repetido) {

    pontos += 20;
    base.push("+20 Lead retornou novamente");
  }

  // 🔥 Classificação final
  let score = "frio";

  if (pontos >= 70) {

    score = "quente";

  } else if (pontos >= 35) {

    score = "morno";
  }

  return {
    score,
    pontos,
    base
  };
}

const ML_LEADS_MIN_AMOSTRAS = 10;
const ML_LEADS_MIN_AMOSTRAS_POR_CLASSE = 4;

const STOPWORDS_ML_LEADS = new Set([
  "a",
  "ao",
  "aos",
  "as",
  "com",
  "da",
  "das",
  "de",
  "do",
  "dos",
  "e",
  "em",
  "na",
  "nas",
  "no",
  "nos",
  "o",
  "os",
  "para",
  "por",
  "que",
  "sem",
  "um",
  "uma"
]);

function normalizarTextoMLLead(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function idadeLeadEmDias(lead: any) {
  const criadoEm =
    new Date(lead?.criado_em).getTime();

  if (!Number.isFinite(criadoEm)) {
    return 0;
  }

  return Math.max(
    0,
    Math.floor(
      (Date.now() - criadoEm) /
      (1000 * 60 * 60 * 24)
    )
  );
}

function textoRespostasQualificacao(lead: any) {
  const respostas =
    Array.isArray(lead?.respostas_qualificacao)
      ? lead.respostas_qualificacao
      : [];

  return respostas
    .map((item: any) => [
      item?.pergunta,
      item?.resposta
    ].filter(Boolean).join(" "))
    .join(" ");
}

function normalizarContatoLead(valor: unknown) {
  return String(valor || "")
    .trim()
    .toLowerCase();
}

function normalizarTelefoneLead(valor: unknown) {
  return String(valor || "")
    .replace(/\D/g, "");
}

function marcarLeadsRecorrentes(leads: any[]) {
  const telefones = new Map<string, number>();
  const emails = new Map<string, number>();

  leads.forEach(lead => {
    const telefone =
      normalizarTelefoneLead(lead.telefone);

    const email =
      normalizarContatoLead(lead.email);

    if (telefone.length >= 8) {
      telefones.set(
        telefone,
        (telefones.get(telefone) || 0) + 1
      );
    }

    if (email) {
      emails.set(
        email,
        (emails.get(email) || 0) + 1
      );
    }
  });

  leads.forEach(lead => {
    const telefone =
      normalizarTelefoneLead(lead.telefone);

    const email =
      normalizarContatoLead(lead.email);

    lead.repetido =
      (
        telefone.length >= 8 &&
        (telefones.get(telefone) || 0) > 1
      ) ||
      (
        Boolean(email) &&
        (emails.get(email) || 0) > 1
      );
  });

  return leads;
}

function adicionarTokensTextoMLLead(
  features: Set<string>,
  value: unknown
) {
  normalizarTextoMLLead(value)
    .split(/[^a-z0-9]+/g)
    .filter(token =>
      token.length >= 3 &&
      !STOPWORDS_ML_LEADS.has(token)
    )
    .slice(0, 36)
    .forEach(token => {
      features.add(`texto:${token}`);
    });
}

function extrairFeaturesMLLead(lead: any) {
  const features = new Set<string>();
  const origem =
    normalizarTextoMLLead(lead?.origem) || "manual";
  const dias =
    idadeLeadEmDias(lead);

  features.add(`origem:${origem}`);

  if (textoOpcional(lead?.email)) {
    features.add("contato:email");
  }

  if (textoOpcional(lead?.telefone)) {
    features.add("contato:telefone");
  }

  if (dias <= 2) {
    features.add("idade:novo");
  } else if (dias <= 7) {
    features.add("idade:semana");
  } else if (dias <= 14) {
    features.add("idade:duas_semanas");
  } else {
    features.add("idade:parado");
  }

  adicionarTokensTextoMLLead(
    features,
    lead?.campanha
  );

  adicionarTokensTextoMLLead(
    features,
    lead?.observacao
  );

  adicionarTokensTextoMLLead(
    features,
    textoRespostasQualificacao(lead)
  );

  return [...features];
}

function incrementarFeatureMLLead(
  mapa: Map<string, number>,
  feature: string
) {
  mapa.set(
    feature,
    (mapa.get(feature) || 0) + 1
  );
}

function treinarModeloMLLeads(leads: any[]) {
  const rotulados =
    leads.filter(lead =>
      lead.status === "fechado" ||
      lead.status === "perdido"
    );

  const positivos =
    rotulados.filter(lead =>
      lead.status === "fechado"
    );

  const negativos =
    rotulados.filter(lead =>
      lead.status === "perdido"
    );

  const modelo = {
    amostras: rotulados.length,
    fechados: positivos.length,
    perdidos: negativos.length,
    positivo: new Map<string, number>(),
    negativo: new Map<string, number>()
  };

  positivos.forEach(lead => {
    extrairFeaturesMLLead(lead)
      .forEach(feature => {
        incrementarFeatureMLLead(
          modelo.positivo,
          feature
        );
      });
  });

  negativos.forEach(lead => {
    extrairFeaturesMLLead(lead)
      .forEach(feature => {
        incrementarFeatureMLLead(
          modelo.negativo,
          feature
        );
      });
  });

  return modelo;
}

function descreverFeatureMLLead(feature: string) {
  const descricoes: Record<string, string> = {
    "contato:email": "email informado",
    "contato:telefone": "telefone informado",
    "idade:novo": "lead recente",
    "idade:semana": "lead com ate 7 dias",
    "idade:duas_semanas": "lead com ate 14 dias",
    "idade:parado": "lead com mais de 14 dias",
    "origem:meta": "origem Meta",
    "origem:manual": "origem manual"
  };

  if (descricoes[feature]) {
    return descricoes[feature];
  }

  if (feature.startsWith("texto:")) {
    return `termo "${feature.replace("texto:", "")}"`;
  }

  if (feature.startsWith("origem:")) {
    return `origem ${feature.replace("origem:", "")}`;
  }

  return feature;
}

function preverConversaoMLLead(
  modelo: ReturnType<typeof treinarModeloMLLeads>,
  lead: any
) {
  if (
    modelo.amostras < ML_LEADS_MIN_AMOSTRAS ||
    modelo.fechados < ML_LEADS_MIN_AMOSTRAS_POR_CLASSE ||
    modelo.perdidos < ML_LEADS_MIN_AMOSTRAS_POR_CLASSE
  ) {
    return {
      disponivel: false,
      status: "aprendendo",
      amostras: modelo.amostras,
      minimo_amostras: ML_LEADS_MIN_AMOSTRAS,
      fechados: modelo.fechados,
      perdidos: modelo.perdidos,
      base: [
        "Marque leads como fechado e perdido para treinar o modelo."
      ]
    };
  }

  const features =
    extrairFeaturesMLLead(lead);

  let logPositivo =
    Math.log((modelo.fechados + 1) / (modelo.amostras + 2));

  let logNegativo =
    Math.log((modelo.perdidos + 1) / (modelo.amostras + 2));

  const sinais: Array<{
    feature: string;
    impacto: number;
  }> = [];

  features.forEach(feature => {
    const ocorrenciasPositivas =
      modelo.positivo.get(feature) || 0;

    const ocorrenciasNegativas =
      modelo.negativo.get(feature) || 0;

    if (
      !ocorrenciasPositivas &&
      !ocorrenciasNegativas
    ) {
      return;
    }

    const probPositiva =
      (ocorrenciasPositivas + 1) /
      (modelo.fechados + 2);

    const probNegativa =
      (ocorrenciasNegativas + 1) /
      (modelo.perdidos + 2);

    logPositivo += Math.log(probPositiva);
    logNegativo += Math.log(probNegativa);

    sinais.push({
      feature,
      impacto:
        Math.log(probPositiva) -
        Math.log(probNegativa)
    });
  });

  const diferenca =
    Math.max(-20, Math.min(20, logPositivo - logNegativo));

  const probabilidade =
    1 / (1 + Math.exp(-diferenca));

  const probabilidadeConversao =
    Math.round(probabilidade * 100);

  const sinaisOrdenados =
    sinais.sort(
      (a, b) =>
        Math.abs(b.impacto) -
        Math.abs(a.impacto)
    );

  const confianca =
    Math.min(
      95,
      Math.round(
        35 +
        Math.min(35, modelo.amostras * 2) +
        Math.min(25, sinais.length * 5)
      )
    );

  const base = [
    `Treinado com ${modelo.fechados} fechados e ${modelo.perdidos} perdidos.`,
    ...sinaisOrdenados
      .slice(0, 3)
      .map(sinal =>
        `${descreverFeatureMLLead(sinal.feature)} puxou a previsao para ${
          sinal.impacto >= 0
            ? "conversao"
            : "perda"
        }.`
      )
  ];

  return {
    disponivel: true,
    status: "pronto",
    probabilidade_conversao: probabilidadeConversao,
    confianca,
    faixa:
      probabilidadeConversao >= 70
        ? "alta"
        : probabilidadeConversao >= 40
        ? "media"
        : "baixa",
    amostras: modelo.amostras,
    fechados: modelo.fechados,
    perdidos: modelo.perdidos,
    sinais_considerados: sinais.length,
    base
  };
}

type TipoUsoIA =
  | "analise_lead"
  | "mensagem_whatsapp"
  | "proxima_acao"
  | "analise_campanha"
  | "followup_lead"
  | "motivo_perda"
  | "reativacao_lote"
  | "criador_campanha"
  | "resumo_diario"
  | "relatorio";

const IA_CUSTO_ESTIMADO_PADRAO = 0.08;
const OPENAI_RESPONSES_URL =
  "https://api.openai.com/v1/responses";

function usuarioTemIA(user: any) {
  return usuarioTemRecurso(user, "ia_leads");
}

function textoLeadIA(lead: any) {
  return [
    lead?.nome,
    lead?.origem,
    lead?.campanha,
    lead?.observacao,
    ...(Array.isArray(lead?.respostas_qualificacao)
      ? lead.respostas_qualificacao.map((item: any) =>
          `${item?.pergunta || ""} ${item?.resposta || ""}`
        )
      : [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function detectarSinaisIA(lead: any, ml: any) {
  const texto = textoLeadIA(lead);
  const sinais: string[] = [];
  const riscos: string[] = [];

  if (texto.includes("visita") || texto.includes("agendar")) {
    sinais.push("demonstrou interesse em visita");
  }

  if (texto.includes("financiamento") || texto.includes("entrada")) {
    sinais.push("mencionou financiamento ou entrada");
  }

  if (texto.includes("urgente") || texto.includes("rapido") || texto.includes("rápido")) {
    sinais.push("indicou urgencia de atendimento");
  }

  if (texto.includes("hoje") || texto.includes("essa semana")) {
    sinais.push("tem indicio de prazo curto");
  }

  if (lead?.telefone) {
    sinais.push("tem telefone para contato imediato");
  }

  if (ml?.disponivel) {
    sinais.push(`ML estima ${ml.probabilidade_conversao || 0}% de conversao`);
  }

  if (texto.includes("sem interesse") || texto.includes("nao quero") || texto.includes("não quero")) {
    riscos.push("sinalizou baixo interesse");
  }

  if (texto.includes("caro") || texto.includes("preco") || texto.includes("preço") || texto.includes("valor alto")) {
    riscos.push("possivel objecao de preco");
  }

  if (texto.includes("sem entrada") || texto.includes("sem credito") || texto.includes("sem crédito")) {
    riscos.push("possivel objecao financeira");
  }

  if (texto.includes("longe") || texto.includes("bairro") || texto.includes("localizacao") || texto.includes("localização")) {
    riscos.push("possivel objecao de localizacao");
  }

  if (!lead?.telefone) {
    riscos.push("telefone nao informado");
  }

  if (!lead?.observacao) {
    riscos.push("ainda nao tem observacoes do atendimento");
  }

  return { sinais, riscos };
}

function gerarAnaliseIAOuroLead(lead: any, ml: any = null) {
  const scoreData =
    lead?.score_pontos !== undefined
      ? {
          score: lead.score,
          pontos: lead.score_pontos,
          base: lead.score_base || []
        }
      : calcularScoreLead(lead);

  const score = scoreData.score || "morno";
  const { sinais, riscos } = detectarSinaisIA(lead, ml);

  const prioridade =
    ml?.disponivel && ml.probabilidade_conversao >= 70
      ? "alta"
      : score === "quente"
      ? "alta"
      : score === "frio"
      ? "baixa"
      : "media";

  const proximaAcao =
    prioridade === "alta"
      ? "Chamar no WhatsApp hoje e tentar agendar uma visita ou conversa objetiva."
      : prioridade === "media"
      ? "Enviar uma mensagem curta de qualificacao e confirmar faixa de valor, regiao e prazo."
      : "Nutrir com uma abordagem leve antes de insistir em visita ou proposta.";

  const mensagemWhatsapp =
    prioridade === "alta"
      ? `Oi ${lead?.nome || "tudo bem"}! Vi seu interesse e queria te ajudar a avancar. Qual melhor horario para falarmos hoje sobre o imovel e uma possivel visita?`
      : prioridade === "media"
      ? `Oi ${lead?.nome || "tudo bem"}! Recebi seu interesse e queria entender melhor o que voce procura. Qual regiao, faixa de valor e prazo ideal para voce?`
      : `Oi ${lead?.nome || "tudo bem"}! Passando para confirmar se ainda faz sentido eu te enviar algumas opcoes de imoveis dentro do que voce procura.`;

  const leadPerdido =
    lead?.status === "perdido";

  const motivoPerda =
    String(lead?.motivo_perda || "")
      .trim()
      .toLowerCase();

  const motivoBaixaRecuperacao =
    [
      "numero_invalido",
      "fake_lead",
      "sem_credito",
      "concorrente"
    ].includes(motivoPerda);

  const chanceRecuperacao =
    !leadPerdido
      ? null
      : motivoBaixaRecuperacao
      ? "baixa"
      : prioridade === "alta" ||
        motivoPerda === "nao_respondeu"
      ? "alta"
      : prioridade === "media" ||
        motivoPerda === "desistiu" ||
        !motivoPerda
      ? "media"
      : "baixa";

  const proximaAcaoFinal =
    !leadPerdido
      ? proximaAcao
      : chanceRecuperacao === "alta"
      ? "Reabrir a conversa hoje com uma mensagem curta, personalizada e sem pressao."
      : chanceRecuperacao === "media"
      ? "Fazer uma tentativa leve de retomada e validar se ainda existe interesse."
      : "Manter no historico ou arquivar depois de revisar o motivo da perda.";

  const mensagemWhatsappFinal =
    !leadPerdido
      ? mensagemWhatsapp
      : chanceRecuperacao === "alta"
      ? `Oi ${lead?.nome || "tudo bem"}! Vi que nosso contato ficou parado, mas talvez ainda faca sentido te ajudar. Quer que eu te envie opcoes atualizadas dentro do que voce estava buscando?`
      : chanceRecuperacao === "media"
      ? `Oi ${lead?.nome || "tudo bem"}! Passando para confirmar se ainda existe interesse. Se fizer sentido, posso retomar com opcoes mais alinhadas para voce.`
      : `Oi ${lead?.nome || "tudo bem"}! So confirmando: ainda faz sentido mantermos seu contato para futuras oportunidades?`;

  const perguntas = [
    "Voce pretende comprar, alugar ou apenas pesquisar por enquanto?",
    "Qual faixa de valor ou parcela mensal fica confortavel?",
    "Tem uma regiao preferida ou bairros que deseja evitar?",
    "Pretende usar financiamento, entrada propria ou outro formato?",
    "Qual prazo ideal para visitar ou decidir?"
  ];

  return {
    disponivel: true,
    nivel: "ouro",
    titulo: "IA Ouro",
    prioridade,
    resumo:
      leadPerdido && chanceRecuperacao === "alta"
        ? "Lead perdido com boa chance de recuperacao; vale retomar com abordagem curta."
        : leadPerdido && chanceRecuperacao === "media"
        ? "Lead perdido com chance moderada; tente validar interesse antes de insistir."
        : leadPerdido
        ? "Lead perdido com baixa chance; melhor manter historico organizado ou arquivar."
        : prioridade === "alta"
        ? "Lead com bons sinais comerciais e recomendacao de contato rapido."
        : prioridade === "media"
        ? "Lead com potencial, mas ainda precisa de qualificacao antes da abordagem forte."
        : "Lead com baixa prioridade no momento; melhor nutrir ou validar interesse.",
    proxima_acao: proximaAcaoFinal,
    mensagem_whatsapp: mensagemWhatsappFinal,
    perguntas_qualificacao: perguntas,
    sinais: sinais.length ? sinais : ["dados ainda limitados para uma analise profunda"],
    riscos,
    explicacao:
      "A IA Ouro cruza a classificacao Frio/Morno/Quente, sinais do cadastro, respostas do formulario, historico do lead e previsao do ML quando disponivel. Ela entrega resumo, prioridade, proxima acao e mensagem pronta para reduzir tempo de atendimento.",
    score_regras: score,
    pontos_regras: scoreData.pontos || 0,
    recuperacao: leadPerdido
      ? {
          chance: chanceRecuperacao,
          motivo_perda: motivoPerda || null,
          recomendacao: proximaAcaoFinal
        }
      : null,
    ml
  };
}

function extrairTextoRespostaOpenAI(data: any) {
  if (typeof data?.output_text === "string") {
    return data.output_text;
  }

  const partes: string[] = [];

  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") {
        partes.push(content.text);
      }
    }
  }

  return partes.join("\n").trim();
}

function calcularCustoEstimadoOpenAI(usage: any) {
  const inputTokens =
    Number(usage?.input_tokens || 0);

  const outputTokens =
    Number(usage?.output_tokens || 0);

  const custoEntradaPorMilhao =
    Number(Bun.env.OPENAI_INPUT_1M_BRL || 0);

  const custoSaidaPorMilhao =
    Number(Bun.env.OPENAI_OUTPUT_1M_BRL || 0);

  if (
    custoEntradaPorMilhao > 0 ||
    custoSaidaPorMilhao > 0
  ) {
    return Number(
      (
        (inputTokens / 1_000_000) *
        custoEntradaPorMilhao +
        (outputTokens / 1_000_000) *
        custoSaidaPorMilhao
      ).toFixed(4)
    );
  }

  return IA_CUSTO_ESTIMADO_PADRAO;
}

function normalizarAnaliseOpenAI(
  analise: any,
  fallback: any
) {
  return {
    disponivel: true,
    nivel: "ouro",
    origem: "openai",
    titulo: "IA Ouro",
    prioridade:
      ["alta", "media", "baixa"].includes(
        analise?.prioridade
      )
        ? analise.prioridade
        : fallback.prioridade,
    resumo:
      textoOpcional(analise?.resumo) ||
      fallback.resumo,
    proxima_acao:
      textoOpcional(analise?.proxima_acao) ||
      fallback.proxima_acao,
    mensagem_whatsapp:
      textoOpcional(analise?.mensagem_whatsapp) ||
      fallback.mensagem_whatsapp,
    perguntas_qualificacao:
      listaOpcional(analise?.perguntas_qualificacao)
        .slice(0, 6),
    sinais:
      listaOpcional(analise?.sinais),
    riscos:
      listaOpcional(analise?.riscos),
    explicacao:
      textoOpcional(analise?.explicacao) ||
      "Analise gerada pela API da OpenAI com base nos dados do lead.",
    score_regras:
      fallback.score_regras,
    pontos_regras:
      fallback.pontos_regras,
    recuperacao:
      analise?.recuperacao &&
      typeof analise.recuperacao === "object" &&
      analise.recuperacao.chance !== "nao_aplicavel"
        ? {
            chance:
              textoOpcional(
                analise.recuperacao.chance
              ) ||
              fallback.recuperacao?.chance ||
              "",
            motivo_perda:
              textoOpcional(
                analise.recuperacao.motivo_perda
              ) ||
              fallback.recuperacao?.motivo_perda ||
              null,
            recomendacao:
              textoOpcional(
                analise.recuperacao.recomendacao
              ) ||
              fallback.recuperacao?.recomendacao ||
              ""
          }
        : fallback.recuperacao || null,
    ml: fallback.ml || null
  };
}

async function buscarConfigIA() {
  const config =
    await client.query(
      `SELECT * FROM ia_config WHERE id = 1 LIMIT 1`
    );

  return config.rows[0] || null;
}

async function gerarAnaliseIAOpenAI(
  lead: any,
  ml: any = null
) {
  const apiKey =
    Bun.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  const modelo =
    textoOpcional(Bun.env.OPENAI_MODEL) ||
    "gpt-5-mini";

  const fallback =
    gerarAnaliseIAOuroLead(lead, ml);

  const payloadLead = {
    id: lead?.id,
    nome: lead?.nome || null,
    telefone: lead?.telefone || null,
    email: lead?.email || null,
    status: lead?.status || "novo",
    motivo_perda: lead?.motivo_perda || null,
    origem: lead?.origem || null,
    campanha: lead?.campanha || null,
    observacao: lead?.observacao || null,
    score: lead?.score || null,
    score_pontos: lead?.score_pontos || 0,
    score_base: lead?.score_base || [],
    respostas_qualificacao:
      Array.isArray(lead?.respostas_qualificacao)
        ? lead.respostas_qualificacao
        : [],
    criado_em: lead?.criado_em || null,
    ml
  };

  const response = await fetch(
    OPENAI_RESPONSES_URL,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: modelo,
        instructions:
          "Voce e uma IA comercial para uma plataforma imobiliaria. Analise o lead, priorize a acao do corretor e, quando o status for perdido, foque em recuperacao. Responda somente no JSON solicitado, em portugues do Brasil, com texto curto, pratico e pronto para uso.",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({
                  lead: payloadLead,
                  objetivo:
                    "Gerar analise comercial, proxima acao, mensagem de WhatsApp e recuperacao quando aplicavel."
                })
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "analise_ia_lead",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: [
                "prioridade",
                "resumo",
                "proxima_acao",
                "mensagem_whatsapp",
                "perguntas_qualificacao",
                "sinais",
                "riscos",
                "explicacao",
                "recuperacao"
              ],
              properties: {
                prioridade: {
                  type: "string",
                  enum: ["alta", "media", "baixa"]
                },
                resumo: {
                  type: "string"
                },
                proxima_acao: {
                  type: "string"
                },
                mensagem_whatsapp: {
                  type: "string"
                },
                perguntas_qualificacao: {
                  type: "array",
                  items: { type: "string" }
                },
                sinais: {
                  type: "array",
                  items: { type: "string" }
                },
                riscos: {
                  type: "array",
                  items: { type: "string" }
                },
                explicacao: {
                  type: "string"
                },
                recuperacao: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "chance",
                    "motivo_perda",
                    "recomendacao"
                  ],
                  properties: {
                    chance: {
                      type: "string",
                      enum: [
                        "alta",
                        "media",
                        "baixa",
                        "nao_aplicavel"
                      ]
                    },
                    motivo_perda: {
                      type: "string"
                    },
                    recomendacao: {
                      type: "string"
                    }
                  }
                }
              }
            }
          }
        },
        max_output_tokens: 1200
      })
    }
  );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      "Erro ao chamar OpenAI"
    );
  }

  const texto =
    extrairTextoRespostaOpenAI(data);

  const analiseModelo =
    JSON.parse(texto);

  return {
    analise:
      normalizarAnaliseOpenAI(
        analiseModelo,
        fallback
      ),
    usage: data?.usage || {},
    custo_estimado:
      calcularCustoEstimadoOpenAI(data?.usage),
    modelo
  };
}

function aplicarMLAoScoreLead(lead: any) {
  const ml = lead?.ml_leads;

  if (!ml?.disponivel) {
    return;
  }

  const probabilidade =
    Number(ml.probabilidade_conversao || 0);

  if (probabilidade >= 75 && lead.score !== "quente") {
    lead.score = "quente";
    lead.score_base = [
      ...(lead.score_base || []),
      `ML elevou para quente com ${probabilidade}% de conversao.`
    ];
    return;
  }

  if (probabilidade <= 25 && lead.score !== "frio") {
    lead.score = "frio";
    lead.score_base = [
      ...(lead.score_base || []),
      `ML reduziu para frio com ${probabilidade}% de conversao.`
    ];
    return;
  }

  if (
    probabilidade >= 55 &&
    probabilidade < 75 &&
    lead.score === "frio"
  ) {
    lead.score = "morno";
    lead.score_base = [
      ...(lead.score_base || []),
      `ML elevou para morno com ${probabilidade}% de conversao.`
    ];
  }
}

async function registrarUsoIA(
  usuarioId: number,
  tipo: TipoUsoIA,
  referenciaTipo: string,
  referenciaId: string | number | null,
  custoEstimado = IA_CUSTO_ESTIMADO_PADRAO,
  tokensEntrada = 0,
  tokensSaida = 0
) {
  await client.query(
    `
    INSERT INTO ia_usos (
      usuario_id,
      tipo,
      referencia_tipo,
      referencia_id,
      tokens_entrada,
      tokens_saida,
      custo_estimado
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      usuarioId,
      tipo,
      referenciaTipo,
      referenciaId ? String(referenciaId) : null,
      tokensEntrada,
      tokensSaida,
      custoEstimado
    ]
  );
}

async function validarLimiteIAUsuario(user: any) {
  const uso = await client.query(
    `
    SELECT
      COUNT(*) AS chamadas_mes,
      COALESCE(SUM(custo_estimado), 0) AS custo_mes
    FROM ia_usos
    WHERE usuario_id = $1
    AND criado_em >= date_trunc('month', CURRENT_DATE)
    `,
    [user.id]
  );

  const chamadasMes = Number(uso.rows[0]?.chamadas_mes || 0);
  const custoMes = Number(uso.rows[0]?.custo_mes || 0);
  const limiteChamadas = Number(user.ia_limite_mensal || 300);
  const limiteCusto = Number(user.ia_custo_limite_mensal || 120);

  if (limiteChamadas > 0 && chamadasMes >= limiteChamadas) {
    return {
      permitido: false,
      motivo: "Limite mensal de chamadas de IA atingido."
    };
  }

  if (limiteCusto > 0 && custoMes >= limiteCusto) {
    return {
      permitido: false,
      motivo: "Limite mensal de custo estimado de IA atingido."
    };
  }

  return {
    permitido: true,
    chamadas_mes: chamadasMes,
    custo_mes: custoMes,
    limite_chamadas: limiteChamadas,
    limite_custo: limiteCusto
  };
}

async function motivoBloqueioIA(user: any) {
  if (!usuarioTemIA(user)) {
    return "IA disponivel apenas no plano Ouro";
  }

  if (!user.ia_ativo) {
    return "IA desativada para este usuario.";
  }

  const configIA =
    await buscarConfigIA();

  if (configIA?.status !== "contratado") {
    return configIA?.status === "pausado"
      ? "Uso da IA pausado pelo administrador."
      : "IA nao configurada pelo administrador.";
  }

  const limiteIA =
    await validarLimiteIAUsuario(user);

  if (!limiteIA.permitido) {
    return limiteIA.motivo;
  }

  return null;
}

function sugestaoIAFallback(
  titulo: string,
  resumo: string,
  acaoPrincipal: string,
  mensagens: string[] = [],
  motivos: string[] = [],
  campos: any[] = [],
  recomendacoes: string[] = []
) {
  return {
    disponivel: true,
    origem: "interna",
    titulo,
    resumo,
    acao_principal: acaoPrincipal,
    mensagens,
    motivos,
    campos,
    recomendacoes
  };
}

async function gerarSugestaoComercialOpenAI(
  objetivo: string,
  dados: any,
  fallback: any
) {
  const apiKey =
    Bun.env.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      sugestao: fallback,
      usage: null,
      custo_estimado: IA_CUSTO_ESTIMADO_PADRAO
    };
  }

  const modelo =
    textoOpcional(Bun.env.OPENAI_MODEL) ||
    "gpt-5-mini";

  try {
    const response = await fetch(
      OPENAI_RESPONSES_URL,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: modelo,
          instructions:
            "Voce e uma IA comercial para corretores imobiliarios. Gere respostas curtas, naturais, praticas e prontas para uso. Responda somente no JSON solicitado, em portugues do Brasil.",
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: JSON.stringify({
                    objetivo,
                    dados
                  })
                }
              ]
            }
          ],
          text: {
            format: {
              type: "json_schema",
              name: "sugestao_comercial_ia",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                required: [
                  "titulo",
                  "resumo",
                  "acao_principal",
                  "mensagens",
                  "motivos",
                  "campos",
                  "recomendacoes"
                ],
                properties: {
                  titulo: { type: "string" },
                  resumo: { type: "string" },
                  acao_principal: { type: "string" },
                  mensagens: {
                    type: "array",
                    items: { type: "string" }
                  },
                  motivos: {
                    type: "array",
                    items: { type: "string" }
                  },
                  campos: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["chave", "valor"],
                      properties: {
                        chave: { type: "string" },
                        valor: { type: "string" }
                      }
                    }
                  },
                  recomendacoes: {
                    type: "array",
                    items: { type: "string" }
                  }
                }
              }
            }
          }
        })
      }
    );

    const data: any =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data?.error?.message ||
        "Erro ao chamar OpenAI"
      );
    }

    const texto =
      extrairTextoRespostaOpenAI(data);

    if (!texto) {
      throw new Error("Resposta vazia da OpenAI");
    }

    return {
      sugestao: {
        ...fallback,
        ...JSON.parse(texto),
        disponivel: true,
        origem: "openai"
      },
      usage: data?.usage || null,
      custo_estimado:
        calcularCustoEstimadoOpenAI(data?.usage)
    };
  } catch (err) {
    console.error("OPENAI SUGESTAO FALLBACK:", err);
    return {
      sugestao: fallback,
      usage: null,
      custo_estimado: IA_CUSTO_ESTIMADO_PADRAO
    };
  }
}


app.use("/*", cors({
  origin: resolverOrigemCors,

  allowMethods: [
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "OPTIONS"
  ],

  allowHeaders: [
    "Content-Type",
    "Authorization"
  ],

  credentials: true,
}));

app.get("/", (c) => c.text("API OK 🚀"));


// 🔐 middleware (token simples)
const authMiddleware = async (c: any, next: any) => {
  try {
    const authHeader = c.req.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Token não fornecido" }, 401);
    }

    const token = authHeader.replace("Bearer ", "").trim();

    const user = decodificarTokenUsuario(token);

    if (!user) {
      return c.json({ error: "Token inválido" }, 401);
    }

    const usuarioAtual = await client.query(
      `
      SELECT
        id,
        email,
        tipo,
        nome,
        sobrenome,
        plano,
        ia_limite_mensal,
        ia_custo_limite_mensal,
        COALESCE(ia_ativo, true) AS ia_ativo,
        COALESCE(ativo, true) AS ativo
      FROM usuarios
      WHERE id = $1
      LIMIT 1
      `,
      [user.id]
    );

    const userBanco =
      usuarioAtual.rows[0];

    if (!userBanco || !userBanco.ativo) {
      return c.json({ error: "Usuário inativo ou não encontrado" }, 401);
    }

    const userAutenticado = {
      ...user,
      ...userBanco,
      plano: normalizarPlano(userBanco.plano),
      recursos: obterRecursosPlano(
        userBanco.plano
      )
    };

    c.set("user", userAutenticado);

    await next();
  } catch (err) {
    console.error("AUTH ERROR:", err);
    return c.json({ error: "Token inválido" }, 401);
  }
};

const masterMiddleware = async (c: any, next: any) => {
  const user = c.get("user");

  if (
    user.tipo !== "master" &&
    user.tipo !== "super_admin"
  ) {
    return c.json({
      error: "Acesso restrito ao administrador"
    }, 403);
  }

  await next();
};

async function listarContasAnuncios(token: string) {

  const adAccounts = await fetch(
    `https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_status,disable_reason,currency,balance,funding_source,funding_source_details,is_prepay_account&access_token=${token}`
  ).then(r => r.json());

  console.log(
    "META AD ACCOUNTS:",
    JSON.stringify(adAccounts, null, 2)
  );

  if (
    adAccounts.error
  ) {

    throw new Error(
      adAccounts.error.message
    );
  }

  if (
    !adAccounts.data ||
    adAccounts.data.length === 0
  ) {

    return [];
  }

  return adAccounts.data;
}

function normalizarValorMonetarioMeta(
  valor: any,
  moeda?: string | null
) {
  if (
    valor === null ||
    valor === undefined ||
    valor === ""
  ) {
    return null;
  }

  const numero = Number(valor);

  if (!Number.isFinite(numero)) {
    return null;
  }

  const moedasSemCentavos = new Set([
    "BIF",
    "CLP",
    "DJF",
    "GNF",
    "JPY",
    "KMF",
    "KRW",
    "MGA",
    "PYG",
    "RWF",
    "UGX",
    "VND",
    "VUV",
    "XAF",
    "XOF",
    "XPF"
  ]);

  return moedasSemCentavos.has(
    String(moeda || "").toUpperCase()
  )
    ? numero
    : numero / 100;
}

function extrairLeadsActionsMeta(actions: any[] = []) {
  const prioridade = [
    "onsite_conversion.lead_grouped",
    "onsite_conversion.lead",
    "lead",
    "offsite_conversion.fb_pixel_lead"
  ];

  for (const tipo of prioridade) {
    const item = actions.find(
      (action: any) =>
        String(action.action_type || "").toLowerCase() === tipo
    );

    if (item) {
      return Number(item.value || 0);
    }
  }

  return actions
    .filter((action: any) =>
      String(action.action_type || "")
        .toLowerCase()
        .includes("lead")
    )
    .reduce(
      (total: number, action: any) =>
        total + Number(action.value || 0),
      0
    );
}

async function obterContaAnuncios(
  token: string,
  contaSelecionadaId?: string | null
) {

  const contas = await listarContasAnuncios(token);

  if (contas.length === 0) {
    return null;
  }

  if (contaSelecionadaId) {
    return contas.find(
      (conta: any) => conta.id === contaSelecionadaId
    ) || null;
  }

  if (contas.length === 1) {
    return contas[0];
  }

  throw new Error(
    "Selecione a conta de anuncios Meta que deseja usar."
  );
}

async function obterContaAnunciosSelecionadaIdUsuario(
  usuarioId: number
) {
  const conn = await client.query(
    `
    SELECT conta_anuncios_id
    FROM meta_conexoes
    WHERE usuario_id = $1
    ORDER BY id DESC
    LIMIT 1
    `,
    [usuarioId]
  );

  return conn.rows[0]?.conta_anuncios_id || null;
}



async function sincronizarTodasCampanhas() {

  try {

    console.log("🔄 AUTO SYNC INICIADO");

    // 🔥 BUSCA TODOS USUÁRIOS COM META
    const usuarios = await client.query(`
      SELECT DISTINCT ON (usuario_id)
        usuario_id,
        access_token,
        conta_anuncios_id
      FROM meta_conexoes
      ORDER BY usuario_id, id DESC
    `);

    for (const user of usuarios.rows) {

      try {

        const token = user.access_token;

        // 🔥 CONTAS
        const contaAds =
          await obterContaAnuncios(
            token,
            user.conta_anuncios_id
          );
        
        if (!contaAds) {

          console.log(
            `⚠️ Usuário ${user.usuario_id} sem conta de anúncios`
          );
        
          continue;
        }
                
        const adAccountId = contaAds.id;

        // 🔥 CAMPANHAS
        const campanhasMeta = await fetch(
          `https://graph.facebook.com/v19.0/${adAccountId}/campaigns?fields=id,name,status,effective_status,objective&limit=500&access_token=${token}`
        ).then(r => r.json());

        if (!campanhasMeta.data) {
          continue;
        }

        for (const campanha of campanhasMeta.data) {

          const statusFinal =
            campanha.status ||
            campanha.effective_status ||
            "UNKNOWN";

          const existe = await client.query(
            `
            SELECT id
            FROM campanhas
            WHERE campaign_id = $1
            `,
            [campanha.id]
          );

          if (existe.rows.length > 0) {

            await client.query(
              `
              UPDATE campanhas
              SET
                nome = $1,
                status = $2,
                conta_anuncios_id = $3,
                atualizado_em = NOW()
              WHERE campaign_id = $4
              `,
              [
                campanha.name,
                statusFinal,
                adAccountId,
                campanha.id
              ]
            );

          } else {

            await client.query(
              `
              INSERT INTO campanhas (
                usuario_id,
                campaign_id,
                conta_anuncios_id,
                nome,
                status,
                origem,
                atualizado_em
              )
              VALUES ($1,$2,$3,$4,$5,$6,NOW())
              `,
              [
                user.usuario_id,
                campanha.id,
                adAccountId,
                campanha.name,
                statusFinal,
                "meta"
              ]
            );
          }
        }

        // 🔥 ATUALIZA ÚLTIMO SYNC
        await client.query(
          `
          UPDATE meta_conexoes
          SET ultimo_sync = NOW()
          WHERE usuario_id = $1
          `,
          [user.usuario_id]
        );

        console.log(
          `✅ Sync usuário ${user.usuario_id}`
        );

      } catch (err) {

        console.error(
          "ERRO USUÁRIO:",
          user.usuario_id,
          err
        );
      }
    }

    console.log("🚀 AUTO SYNC FINALIZADO");

  } catch (err) {

    console.error(
      "ERRO AUTO SYNC:",
      err
    );
  }
}



app.post("/usuarios", authMiddleware, masterMiddleware, async (c) => {
  const body = await c.req.json();

  const { email, senha } = body;

  try {
    const senhaHash = await gerarHashSenha(senha);

    await client.query(
      "INSERT INTO usuarios (email, senha, tipo) VALUES ($1,$2,'cliente')",
      [email, senhaHash]
    );

    return c.json({ message: "Usuário criado" });

  } catch {
    return c.json({ error: "Usuário já existe" }, 400);
  }
});

app.get("/usuarios", authMiddleware, masterMiddleware, async (c) => {
  const result = await client.query(
    "SELECT id, email, tipo FROM usuarios ORDER BY id DESC"
  );

  return c.json(result.rows);
});

app.delete("/usuarios/:id", authMiddleware, masterMiddleware, async (c) => {
  const id = c.req.param("id");

  await client.query("DELETE FROM usuarios WHERE id=$1", [id]);

  return c.json({ message: "Usuário removido" });
});

app.put("/admin/usuarios/:id/status", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    if (user.tipo !== "super_admin") {
      return c.json({
        error: "Acesso negado"
      }, 403);
    }

    const id = c.req.param("id");

    const body = await c.req.json();

    const ativo = body.ativo;

    await client.query(`
      UPDATE usuarios
      SET ativo = $1
      WHERE id = $2
    `, [ativo, id]);

    return c.json({
      success: true
    });

  } catch (err) {

    console.error("ERRO STATUS USUARIO:", err);

    return c.json({
      error: "Erro ao alterar status"
    }, 500);
  }
});


app.put("/admin/usuarios/:id/vinculo", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    if (user.tipo !== "super_admin") {
      return c.json({
        error: "Acesso negado"
      }, 403);
    }

    const id = c.req.param("id");

    const body = await c.req.json();

    await client.query(`
      UPDATE usuarios
      SET admin_id = $1
      WHERE id = $2
    `, [
      body.admin_id || null,
      id
    ]);

    return c.json({
      success: true
    });

  } catch (err) {

    console.error("ERRO VINCULO:", err);

    return c.json({
      error: "Erro ao alterar vínculo"
    }, 500);
  }
});


app.put("/usuarios/:id", authMiddleware, masterMiddleware, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  await client.query(
    "UPDATE usuarios SET email=$1 WHERE id=$2",
    [body.email, id]
  );

  return c.json({ message: "Usuário atualizado" });
});


/* =========================
   🔗 META LOGIN
========================= */

// 🔹 REDIRECIONA PARA LOGIN META
app.get("/auth/meta/login", async (c) => {
  try {

  const token = c.req.query("token");

  if (!token) {
    return c.text("Token não enviado");
  }

  const usuario =
    decodificarTokenUsuario(token);

  if (!usuario?.id) {
    return c.text("Token invalido ou expirado", 401);
  }

  const clientId = Bun.env.META_APP_ID;
  const redirectUri = Bun.env.META_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return c.text("Configuracao Meta incompleta", 500);
  }

  // State temporario de uso unico para o OAuth da Meta.
  const state = gerarMetaOAuthState();
  const stateHash = hashMetaOAuthState(state);

  await client.query(
    `
    DELETE FROM meta_oauth_states
    WHERE expira_em <= NOW()
    OR usado_em IS NOT NULL
    `
  );

  await client.query(
    `
    INSERT INTO meta_oauth_states (
      state_hash,
      usuario_id,
      expira_em
    )
    VALUES (
      $1,
      $2,
      NOW() + ($3 || ' minutes')::interval
    )
    `,
    [
      stateHash,
      usuario.id,
      META_OAUTH_STATE_TTL_MINUTES
    ]
  );

  const scopes = [

    "ads_management",
    "ads_read",
    "business_management",
    "leads_retrieval",
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_ads"

  ].join(",");

  const params =
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes,
      state
    });

  const url =
    `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`;

  return c.redirect(url);
  } catch (err) {
    console.error("ERRO LOGIN META:", err);
    return c.text("Erro ao iniciar conexao Meta", 500);
  }
});


// 🔹 CALLBACK (SALVA TOKEN)
app.get("/auth/meta/callback", async (c) => {
  try {
    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!state) {
      return c.text("State nao recebido");
    }

    if (!code) {
      return c.text("Erro: code não recebido");
    }

    const clientId = Bun.env.META_APP_ID;
    const clientSecret = Bun.env.META_APP_SECRET;
    const redirectUri = Bun.env.META_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      return c.text("Configuracao Meta incompleta", 500);
    }

    // 🔥 troca code por token
    const stateHash = hashMetaOAuthState(state);
    const db = await client.connect();
    let usuarioId: number | null = null;

    try {
      await db.query("BEGIN");

      const stateResult = await db.query(
        `
        SELECT id, usuario_id
        FROM meta_oauth_states
        WHERE state_hash = $1
        AND usado_em IS NULL
        AND expira_em > NOW()
        LIMIT 1
        FOR UPDATE
        `,
        [stateHash]
      );

      if (stateResult.rows.length === 0) {
        await db.query("ROLLBACK");
        return c.text("State invalido ou expirado", 401);
      }

      usuarioId = Number(stateResult.rows[0].usuario_id);

      await db.query(
        `
        UPDATE meta_oauth_states
        SET usado_em = NOW()
        WHERE id = $1
        `,
        [stateResult.rows[0].id]
      );

      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    } finally {
      db.release();
    }

    const params =
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        client_secret: clientSecret,
        code
      });

    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?${params.toString()}`
    );

    const tokenData = await tokenRes.json();
    const access_token = tokenData.access_token;

    if (!tokenRes.ok || !access_token) {
      console.error("ERRO TOKEN META:", tokenData);
      return c.text("Erro ao obter token Meta", 502);
    }

    console.log("META conectada com sucesso");

    if (!usuarioId) {
      return c.text("Usuário inválido", 401);
    }

    // 💾 salva no banco
    await client.query(
      "INSERT INTO meta_conexoes (usuario_id, access_token) VALUES ($1, $2)",
      [usuarioId, access_token]
    );

    return c.html(`
      <script>
        alert("Conta conectada e salva com sucesso 🚀");
        window.close();
      </script>
    `);

  } catch (err) {
    console.error("ERRO META:", err);
    return c.text("Erro ao conectar Meta");
  }
});


/* =========================
   🧪 TESTE META
========================= */

app.get("/meta/teste", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");

    const result = await client.query(
      "SELECT access_token FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1",
      [user.id]
    );

    if (result.rows.length === 0) {
      return c.json({ error: "Nenhuma conexão encontrada" });
    }

    const token = result.rows[0].access_token;

    const fbRes = await fetch(
      `https://graph.facebook.com/v19.0/me/accounts?access_token=${token}`
    );

    const data = await fbRes.json();

    return c.json(data);

  } catch (err) {
    console.error("ERRO TESTE META:", err);
    return c.json({ error: "Erro ao testar conexão" }, 500);
  }
});

app.post("/meta/conta-anuncios", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const body = await c.req.json();
    const contaAnunciosId =
      String(body.conta_anuncios_id || "").trim();

    if (!contaAnunciosId) {
      return c.json({
        error: "Selecione uma conta de anuncios Meta."
      }, 400);
    }

    const conn = await client.query(
      `
      SELECT id, access_token
      FROM meta_conexoes
      WHERE usuario_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [user.id]
    );

    if (conn.rows.length === 0) {
      return c.json({
        error: "Meta nao conectada"
      }, 400);
    }

    const contas =
      await listarContasAnuncios(conn.rows[0].access_token);

    const conta = contas.find(
      (item: any) => item.id === contaAnunciosId
    );

    if (!conta) {
      return c.json({
        error: "Conta de anuncios nao disponivel nesta conexao Meta."
      }, 400);
    }

    await client.query(
      `
      UPDATE meta_conexoes
      SET conta_anuncios_id = $1
      WHERE id = $2
      `,
      [conta.id, conn.rows[0].id]
    );

    return c.json({
      sucesso: true,
      conta_anuncios: {
        id: conta.id,
        nome: conta.name
      }
    });

  } catch (err: any) {
    console.error("SELECIONAR CONTA META:", err);

    return c.json({
      error:
        err?.message ||
        "Erro ao selecionar conta de anuncios Meta"
    }, 500);
  }
});


app.post("/meta/campanha", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const {
      usuario_id,
      nome,
      objetivo,
      configuracoes_avancadas
    } = await c.req.json();

    const usuarioId =
      resolverUsuarioIdOperacao(user, usuario_id);

    if (!usuarioId) {
      return negarAcessoConta(c);
    }

    const conn = await client.query(
      "SELECT access_token, conta_anuncios_id FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1",
      [usuarioId]
    );

    const token = conn.rows[0].access_token;

    const contaAds =
      await obterContaAnuncios(
        token,
        conn.rows[0].conta_anuncios_id
      );
    
    if (!contaAds) {
    
      return c.json({
        error: "Nenhuma conta de anúncios encontrada"
      }, 400);
    }
    
    const adAccountId = contaAds.id;

    const categoriaEspecial =
      textoOpcional(
        configuracoes_avancadas?.categoria_especial
      );

    const specialAdCategories =
      categoriaEspecial
        ? [categoriaEspecial]
        : [];
    
    const campanha = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/campaigns`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nome || "Campanha Leads Plataforma",
          objective: objetivo || "OUTCOME_LEADS",
          status: "PAUSED",
          special_ad_categories: specialAdCategories,
          is_adset_budget_sharing_enabled: false,
          access_token: token
        })
      }
    ).then(r => r.json());

    if (!campanha.id) {

      return c.json({
        error: "Erro ao criar campanha",
        detalhe: campanha
      }, 400);
    }
    
    await client.query(
      `
      INSERT INTO campanhas (
        usuario_id,
        campaign_id,
        conta_anuncios_id,
        nome,
        status,
        origem,
        configuracoes_avancadas
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      `,
      [
        usuarioId,
        campanha.id,
        adAccountId,
        nome || "Campanha Plataforma",
        "PAUSED",
        "plataforma",
        JSON.stringify(configuracoes_avancadas || {})
      ]
    );

    return c.json(campanha);

  } catch (err) {

      console.error(
        "ERRO COMPLETO CAMPANHA:",
        err
      );
    
      return c.json({
        error: String(err) || "Erro ao criar campanha"
      }, 500);
  }
});

app.post("/meta/adset", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const {
      usuario_id,
      campaign_id,
      page_id,
      form_id,
      daily_budget,
      configuracoes_avancadas
    } = await c.req.json();

    const usuarioId =
      resolverUsuarioIdOperacao(user, usuario_id);

    if (!usuarioId) {
      return negarAcessoConta(c);
    }

    const conn = await client.query(
      "SELECT access_token, conta_anuncios_id FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1",
      [usuarioId]
    );

    const token = conn.rows[0].access_token;

    const contaAds =
      await obterContaAnuncios(
        token,
        conn.rows[0].conta_anuncios_id
      );
    
    if (!contaAds) {
    
      return c.json({
        error: "Nenhuma conta de anúncios encontrada"
      }, 400);
    }
    
    const adAccountId = contaAds.id;

    const avancadas =
      configuracoes_avancadas || {};

    const targeting =
      montarTargetingMeta(avancadas);

    const categoriaEspecial =
      textoOpcional(avancadas.categoria_especial);

    if (
      [
        "HOUSING",
        "CREDIT",
        "EMPLOYMENT"
      ].includes(categoriaEspecial)
    ) {
      delete targeting.age_min;
      delete targeting.age_max;
      delete targeting.genders;
    }

    const inicio =
      textoOpcional(avancadas.inicio);

    const fim =
      textoOpcional(avancadas.fim);

    const bidStrategy =
      textoOpcional(avancadas.bid_strategy) ||
      "LOWEST_COST_WITHOUT_CAP";

    const bidAmount =
      numeroOpcional(avancadas.bid_amount);

    const payloadAdset: any = {
      name: `AdSet Leads ${Date.now()}`,

      campaign_id,

      billing_event: "IMPRESSIONS",

      optimization_goal: "LEAD_GENERATION",

      destination_type: "ON_AD",

      bid_strategy: bidStrategy,

      daily_budget: daily_budget || 2000,

      start_time: inicio
        ? new Date(inicio).toISOString()
        : new Date(Date.now() + 60000).toISOString(),

      targeting,

      promoted_object: {
        page_id
      },

      status: "PAUSED",

      access_token: token
    };

    if (fim) {
      payloadAdset.end_time =
        new Date(fim).toISOString();
    }

    if (
      bidAmount !== null &&
      bidStrategy !== "LOWEST_COST_WITHOUT_CAP"
    ) {
      payloadAdset.bid_amount =
        Math.round(bidAmount * 100);
    }

    const adset = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/adsets`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadAdset)
      }
    ).then(r => r.json());

    console.log(
      "ADSET PAYLOAD:",
      JSON.stringify(payloadAdset, null, 2)
    );

    console.log("ADSET RESPONSE:", adset);

    if (adset.error) {
      return c.json({
        error: adset.error,
        targeting_enviado: targeting
      }, 400);
    }

    return c.json(adset);

  } catch (err) {
    console.error(err);
    return c.json({ error: "Erro ao criar adset" }, 500);
  }
});


app.post("/meta/formulario", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const {
      usuario_id,
      adset_id,
      page_id,
      form_id,
      texto,
      cta,
      configuracoes_avancadas
    } = await c.req.json();

    const usuarioId =
      resolverUsuarioIdOperacao(user, usuario_id);

    if (!usuarioId) {
      return negarAcessoConta(c);
    }

    // 🔐 pega token salvo
    const conn = await client.query(
      "SELECT access_token FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1",
      [usuarioId]
    );

    if (conn.rows.length === 0) {
      return c.json({ error: "Meta não conectada" }, 400);
    }

    const userToken = conn.rows[0].access_token;

    // 🔥 pega PAGE TOKEN (IMPORTANTE)
    const pages = await fetch(
      `https://graph.facebook.com/v19.0/me/accounts?access_token=${userToken}`
    ).then(r => r.json());

    const page = pages.data.find((p: any) => p.id === page_id);

    if (!page) {
      return c.json({ error: "Página não encontrada no token" }, 400);
    }

    const pageToken = page.access_token;

    const avancadas =
      configuracoes_avancadas || {};

    const perguntasBase: any[] = [
      { type: "FULL_NAME" },
      { type: "EMAIL" },
      { type: "PHONE" }
    ];

    const perguntasExtras =
      listaOpcional(avancadas.perguntas)
        .slice(0, 10)
        .map((pergunta, index) => ({
          type: "CUSTOM",
          key: `qualificacao_${index + 1}`,
          label: pergunta
        }));

    const linkPrivacidade =
      urlOpcional(
        avancadas.privacidade_url,
        "https://google.com"
      );

    const obrigadoUrl =
      urlOpcional(
        avancadas.obrigado_url,
        "https://google.com"
      );

    const payloadFormulario: any = {
      name: `Form Leads ${Date.now()}`,
      locale: "pt_BR",
      questions: [
        ...perguntasBase,
        ...perguntasExtras
      ],
      privacy_policy: {
        url: linkPrivacidade,
        link_text:
          textoOpcional(
            avancadas.privacidade_texto
          ) || "Política de Privacidade"
      },
      thank_you_page: {
        title:
          textoOpcional(
            avancadas.obrigado_titulo
          ) || "Obrigado!",
        body:
          textoOpcional(
            avancadas.obrigado_texto
          ) || "Recebemos seus dados 🚀",
        button_type: "VIEW_WEBSITE",
        button_text:
          textoOpcional(
            avancadas.obrigado_botao
          ) || "Ver mais",
        website_url: obrigadoUrl
      },
      access_token: pageToken
    };

    if (avancadas.formulario_qualidade) {
      payloadFormulario.is_optimized_for_quality = true;
    }

    // 🚀 cria formulário
    const form = await fetch(
      `https://graph.facebook.com/v19.0/${page_id}/leadgen_forms`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadFormulario)
      }
    ).then(r => r.json());

    return c.json(form);

  } catch (err) {
    console.error("ERRO FORM:", err);
    return c.json({ error: "Erro ao criar formulário" }, 500);
  }
});


app.post("/meta/upload-imagem", authMiddleware, async (c) => {

  try {
    const user: any = c.get("user");

    const body = await c.req.formData();

    console.log("BODY RECEBIDO");

    const imagem = body.get("imagem") as File;

    console.log(
      "IMAGEM:",
      imagem?.name,
      imagem?.size,
      imagem?.type
    );

    const usuario_id = body.get("usuario_id");
    const usuarioId =
      resolverUsuarioIdOperacao(user, usuario_id);

    if (!usuarioId) {
      return negarAcessoConta(c);
    }

    console.log(
      "USUARIO:",
      usuario_id
    );

    if (!imagem) {

      return c.json({
        error: "Imagem não enviada"
      }, 400);
    }

    // 🔐 TOKEN META
    const conn = await client.query(
      `
      SELECT access_token, conta_anuncios_id
      FROM meta_conexoes
      WHERE usuario_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [usuarioId]
    );

    if (conn.rows.length === 0) {

      return c.json({
        error: "Meta não conectada"
      }, 400);
    }

    const token = conn.rows[0].access_token;

    // 🔥 CONTA DE ANÚNCIOS
    const contaAds =
      await obterContaAnuncios(
        token,
        conn.rows[0].conta_anuncios_id
      );

    if (!contaAds) {

      return c.json({
        error: "Conta anúncios não encontrada"
      }, 400);
    }

    const adAccountId = contaAds.id;

    console.log(
      "AD ACCOUNT:",
      adAccountId
    );

    // 🔥 FORMDATA PARA META
    const metaForm = new FormData();

    metaForm.append(
      "filename",
      imagem,
      imagem.name
    );

    metaForm.append(
      "access_token",
      token
    );

    // 🔥 UPLOAD PARA META
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/adimages`,
      {
        method: "POST",
        body: metaForm
      }
    );
    
    const texto = await response.text();
    
    console.log(
      "STATUS META:",
      response.status
    );
    
    console.log(
      "RESPOSTA META:",
      texto
    );
    
    const upload = JSON.parse(texto);

    console.log(
      "UPLOAD META:",
      JSON.stringify(upload, null, 2)
    );

    // 🔥 HASH DA IMAGEM
    const primeiraImagem =
      Object.values(upload.images || {})?.[0] as any;

    const hash = primeiraImagem?.hash;

    if (!hash) {

      return c.json({
        error: "Erro upload imagem",
        detalhe: upload
      }, 400);
    }

    return c.json({
      sucesso: true,
      hash
    });

  } catch (err) {

    console.error(
      "UPLOAD IMAGEM:",
      err
    );

    return c.json({
      error: "Erro upload imagem"
    }, 500);
  }
});



app.post("/meta/anuncio", authMiddleware, async (c) => {

  try {
    const user: any = c.get("user");

    const {
      usuario_id,
      campaign_id,
      adset_id,
      page_id,
      form_id,
      texto,
      cta,
      campanha_nome,
      configuracoes_avancadas,
      imageHash,
      imageHashes
    } = await c.req.json();

    const usuarioId =
      resolverUsuarioIdOperacao(user, usuario_id);

    if (!usuarioId) {
      return negarAcessoConta(c);
    }

    console.log("IMAGE HASH:", imageHash);

    console.log("FORM ID:", form_id);

    console.log("PAGE ID:", page_id);

    console.log("ADSET ID:", adset_id);

    console.log("CAMPAIGN ID:", campaign_id);

    if (!form_id) {

      return c.json({
        error: "form_id não enviado"
      }, 400);
    }

    // 🔐 TOKEN META
    const conn = await client.query(
      `
      SELECT access_token, conta_anuncios_id
      FROM meta_conexoes
      WHERE usuario_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [usuarioId]
    );

    if (conn.rows.length === 0) {

      return c.json({
        error: "Meta não conectada"
      }, 400);
    }

    const token = conn.rows[0].access_token;

    // 🔥 CONTA ADS
    const contaAds =
      await obterContaAnuncios(
        token,
        conn.rows[0].conta_anuncios_id
      );

    if (!contaAds) {

      return c.json({
        error: "Nenhuma conta de anúncios encontrada"
      }, 400);
    }

    const adAccountId = contaAds.id;

    const avancadas =
      configuracoes_avancadas || {};

    const linkDestino =
      urlOpcional(
        avancadas.link,
        "https://google.com"
      );

    const tituloAnuncio =
      textoOpcional(avancadas.titulo) ||
      "Saiba mais";

    const descricaoAnuncio =
      textoOpcional(avancadas.descricao) ||
      "Entre em contato agora";

    // 🔥 CRIATIVO
    const hashes: string[] =
      Array.isArray(imageHashes) && imageHashes.length > 0
        ? imageHashes
        : imageHash
        ? [imageHash]
        : [];

    const isCarrossel = hashes.length > 1;

    const ctaType = cta || "LEARN_MORE";

    const linkDataBase: Record<string, any> = {
      message: texto || "Quer mais clientes? 🚀"
    };

    if (isCarrossel) {
      linkDataBase.child_attachments = hashes.map((hash, i) => ({
        link: linkDestino,
        image_hash: hash,
        name: i === 0 ? tituloAnuncio : `Slide ${i + 1}`,
        call_to_action: {
          type: ctaType,
          value: { lead_gen_form_id: form_id }
        }
      }));
      linkDataBase.multi_share_end_card = false;
    } else {
      linkDataBase.link = linkDestino;
      linkDataBase.image_hash = hashes[0] || imageHash;
      linkDataBase.name = tituloAnuncio;
      linkDataBase.description = descricaoAnuncio;
      linkDataBase.call_to_action = {
        type: ctaType,
        value: { lead_gen_form_id: form_id }
      };
    }

    const creative = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/adcreatives`,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({

          name: `Criativo Leads ${Date.now()}`,

          object_story_spec: {
            page_id,
            link_data: linkDataBase
          },

          access_token: token
        })
      }
    ).then(r => r.json());

    console.log(
      "CREATIVE RESPONSE:",
      creative
    );

    if (!creative.id) {

      console.error(
        "ERRO CREATIVE COMPLETO:",
        creative
      );

      return c.json({
        error: "Erro ao criar criativo",
        detalhe:
          creative.error || creative
      }, 400);
    }

    // 🔥 ANÚNCIO
    const adRes = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/ads`,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({

          name:
            `Anúncio Leads ${Date.now()}`,

          adset_id,

          creative: {
            creative_id: creative.id
          },

          status: "PAUSED",

          access_token: token
        })
      }
    );

    const ad = await adRes.json();

    console.log("AD RESPONSE:", ad);

    if (!ad.id) {

      console.error("ERRO AD:", ad);

      return c.json({
        error: "Erro ao criar anúncio",
        detalhe: ad
      }, 400);
    }

    // 🔎 DEBUG CAMPANHAS
    console.log(
      "UPDATE IDS:",
      {
        campaign_id_recebido: campaign_id,
        adset_id: adset_id,
        ad_id: ad.id
      }
    );

    const campanhasBanco =
      await client.query(
        `
        SELECT
          id,
          nome,
          campaign_id
        FROM campanhas
        ORDER BY id DESC
        LIMIT 5
        `
      );

    console.log(
      "CAMPANHAS BANCO:",
      campanhasBanco.rows
    );

    // 💾 UPDATE CAMPANHA
    const update = await client.query(
      `
      UPDATE campanhas
      SET
        adset_id = $1,
        ad_id = $2,
        form_id = $3,
        page_id = $4
      WHERE CAST(campaign_id AS TEXT) = $5
      `,
      [
        adset_id,
        ad.id,
        form_id,
        page_id,
        String(campaign_id)
      ]
    );

    console.log(
      "UPDATED ROWS:",
      update.rowCount
    );

    return c.json(ad);

  } catch (err: any) {

    console.error(
      "ERRO ANUNCIO COMPLETO:",
      err
    );

    return c.json({
      error: "Erro ao criar anúncio",
      detalhe:
        err?.message || err
    }, 500);
  }
});


app.get(
  "/meta/status-completo",
  authMiddleware,
  async (c) => {

  try {

    const user: any = c.get("user");

    const usuario_id = user.id;

    // 🔐 TOKEN
    const conn = await client.query(
      `
      SELECT access_token, ultimo_sync, conta_anuncios_id
      FROM meta_conexoes
      WHERE usuario_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [usuario_id]
    );

    if (conn.rows.length === 0) {

      return c.json({
        conectado: false,
        erro: "Meta não conectada"
      });
    }

    const token = conn.rows[0].access_token;

    // 🔥 USUÁRIO META
    const me = await fetch(
      `https://graph.facebook.com/v19.0/me?fields=id,name,picture&access_token=${token}`
    ).then(r => r.json());

    // 🔥 CONTAS DE ANÚNCIOS
    const contasAds =
      await listarContasAnuncios(token);

    const contaAds =
      conn.rows[0].conta_anuncios_id
        ? await obterContaAnuncios(
            token,
            conn.rows[0].conta_anuncios_id
          )
        : contasAds.length === 1
        ? contasAds[0]
        : null;

    if (
      !conn.rows[0].conta_anuncios_id &&
      contasAds.length === 1
    ) {
      await client.query(
        `
        UPDATE meta_conexoes
        SET conta_anuncios_id = $1
        WHERE usuario_id = $2
        AND id = (
          SELECT id
          FROM meta_conexoes
          WHERE usuario_id = $2
          ORDER BY id DESC
          LIMIT 1
        )
        `,
        [contasAds[0].id, usuario_id]
      );
    }

    if (contasAds.length === 0) {
      return c.json({
        error: "Nenhuma conta de anuncios encontrada"
      }, 400);
    }

    if (!contaAds) {
      const paginasSemConta =
        await listarPaginasComInstagram(token);

      return c.json({
        conectado: true,
        possui_conta_anuncios: true,
        selecao_conta_anuncios_pendente: true,
        usuario_meta: me,
        conta_anuncios: null,
        contas_anuncios: contasAds.map((conta: any) => ({
          id: conta.id,
          nome: conta.name,
          status: conta.account_status,
          moeda: conta.currency || null
        })),
        paginas: paginasSemConta,
        instagram: null,
        metricas: {
          campanhas: 0,
          campanhas_ativas: 0,
          leads_hoje: 0,
          gasto_hoje: 0,
          gasto_hoje_formatado: "R$ 0,00",
          ultimo_sync: conn.rows[0].ultimo_sync || null
        },
        pronto_para_anunciar: false
      });
    }
    
    if (!contaAds) {
    
      return c.json({
        error: "Nenhuma conta de anúncios encontrada"
      }, 400);
    }
    
    const adAccountId = contaAds.id;

    const conta = contaAds;

    // 🔥 PÁGINAS
    const paginas =
      await listarPaginasComInstagram(token);

    const primeiraPagina = paginas[0];

    // 🔥 INSTAGRAM
    let instagram =
      paginas.find((pagina: any) =>
        pagina.instagram?.id
      )?.instagram || null;

    if (!instagram && primeiraPagina?.id) {

      const instaRes = await fetch(
        `https://graph.facebook.com/v19.0/${primeiraPagina.id}?fields=instagram_business_account&access_token=${token}`
      ).then(r => r.json());

      if (instaRes.instagram_business_account?.id) {

        const instaInfo = await fetch(
          `https://graph.facebook.com/v19.0/${instaRes.instagram_business_account.id}?fields=username,profile_picture_url&access_token=${token}`
        ).then(r => r.json());

        instagram = instaInfo;
      }
    }

    // 🔥 MÉTRICAS

    const campanhasCount = await client.query(
      `
      SELECT COUNT(*) as total
      FROM campanhas
      WHERE usuario_id = $1
      AND conta_anuncios_id = $2
      `,
      [usuario_id, adAccountId]
    );

    const campanhasAtivas = await client.query(
      `
      SELECT COUNT(*) as total
      FROM campanhas
      WHERE usuario_id = $1
      AND conta_anuncios_id = $2
      AND UPPER(status) IN ('ACTIVE', 'ENABLED')
      `,
      [usuario_id, adAccountId]
    );

    const leadsHojeBanco = await client.query(
      `
      SELECT COUNT(*) as total
      FROM leads
      WHERE usuario_id = $1
      AND (
        COALESCE(origem, 'manual') <> 'meta'
        OR conta_anuncios_id = $2
      )
      AND DATE(criado_em) = CURRENT_DATE
      `,
      [usuario_id, adAccountId]
    );

    let gastoHoje = 0;
    let leadsHojeMeta = 0;
    let campanhasMetaTotal: number | null = null;
    let campanhasMetaAtivas: number | null = null;

    try {

      const insightsHoje = await fetch(
        `https://graph.facebook.com/v19.0/${adAccountId}/insights?fields=spend,actions&date_preset=today&access_token=${token}`
      ).then(r => r.json());

      gastoHoje =
        Number(insightsHoje.data?.[0]?.spend || 0);
      leadsHojeMeta =
        extrairLeadsActionsMeta(
          insightsHoje.data?.[0]?.actions || []
        );

    } catch (err) {

      console.error(
        "ERRO GASTO HOJE:",
        err
      );
    }

    try {

      const campanhasMetaStatus = await fetch(
        `https://graph.facebook.com/v19.0/${adAccountId}/campaigns?fields=id,status,effective_status&limit=500&access_token=${token}`
      ).then(r => r.json());

      if (campanhasMetaStatus.data) {
        campanhasMetaTotal =
          campanhasMetaStatus.data.length;
        campanhasMetaAtivas =
          campanhasMetaStatus.data.filter((campanha: any) =>
            [
              campanha.effective_status,
              campanha.status
            ]
              .filter(Boolean)
              .map((status: string) =>
                status.toUpperCase()
              )
              .some((status: string) =>
                status === "ACTIVE" ||
                status === "ENABLED"
              )
          ).length;
      }

    } catch (err) {

      console.error(
        "ERRO CAMPANHAS STATUS META:",
        err
      );
    }

    const campanhasBancoTotal =
      Number(campanhasCount.rows[0].total || 0);

    const campanhasBancoAtivas =
      Number(campanhasAtivas.rows[0].total || 0);

    const leadsHojePlataforma =
      Number(leadsHojeBanco.rows[0]?.total || 0);

    const leadsHojeFinal =
      leadsHojePlataforma;

    const gastoHojeFormatado =
      new Intl.NumberFormat(
        "pt-BR",
        {
          style: "currency",
          currency: "BRL"
        }
      ).format(gastoHoje);

    const contaAtiva =
      conta.account_status === 1;

    const pagamentoAutomatico =
      Boolean(conta.funding_source);

    const pagamentoManual =
      conta.is_prepay_account === true;

    const pagamentoHabilitado =
      pagamentoAutomatico ||
      pagamentoManual;

    const saldoApi =
      normalizarValorMonetarioMeta(
        conta.balance,
        conta.currency
      );

    const saldoPrePago = null;

    const tipoPagamento =
      pagamentoManual
        ? "manual_pre_pago"
        : pagamentoAutomatico
        ? "metodo_detectado"
        : "nao_identificado";

    // 🔥 STATUS FINAL
    return c.json({

      conectado: true,

      possui_conta_anuncios: true,

      usuario_meta: me,

      conta_anuncios: {
        existe: true,
        id: conta.id,
        nome: conta.name,
        status: conta.account_status,
        motivo_desativacao: conta.disable_reason || null,
        moeda: conta.currency || null,
        saldo:
          pagamentoManual
            ? saldoPrePago
            : saldoApi,
        saldo_pre_pago: saldoPrePago,
        saldo_pendente_api: saldoApi,
        saldo_bruto_api: conta.balance ?? null,
        pre_pago: pagamentoManual,
        ativa: contaAtiva,
        tipo_pagamento: tipoPagamento,
        pagamento_automatico: pagamentoAutomatico,
        pagamento_manual: pagamentoManual,
        pagamento_habilitado: pagamentoHabilitado,
        possui_pagamento: pagamentoHabilitado
      },

      contas_anuncios: contasAds.map((conta: any) => ({
        id: conta.id,
        nome: conta.name,
        status: conta.account_status,
        moeda: conta.currency || null
      })),

      paginas,

      instagram,

      metricas: {
        campanhas: campanhasBancoTotal,
        campanhas_ativas: campanhasBancoAtivas,
        campanhas_meta:
          campanhasMetaTotal,
        campanhas_ativas_meta:
          campanhasMetaAtivas,
        campanhas_origem: "banco",
        leads_hoje: leadsHojeFinal,
        leads_hoje_meta: leadsHojeMeta,
        leads_hoje_plataforma: leadsHojePlataforma,
        gasto_hoje: gastoHoje,
        gasto_hoje_formatado: gastoHojeFormatado,
        ultimo_sync:
          conn.rows[0].ultimo_sync || null
      },

      pronto_para_anunciar:
        contaAtiva &&
        pagamentoHabilitado
    });

  } catch (err: any) {
  
      console.error(
        "STATUS META ERRO COMPLETO:",
        err
      );
    
      return c.json({
        erro: "Erro ao validar Meta",
        detalhe: err?.message || err
      }, 500);
    }
});

app.post("/meta/direcionamento/interesses", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const {
      usuario_id,
      busca
    } = await c.req.json();

    const usuarioId =
      resolverUsuarioIdOperacao(user, usuario_id);

    if (!usuarioId) {
      return negarAcessoConta(c);
    }

    const termo =
      textoOpcional(busca)
        .slice(0, 80);

    if (termo.length < 2) {
      return c.json({ data: [] });
    }

    const conn = await client.query(
      "SELECT access_token FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1",
      [usuarioId]
    );

    if (!conn.rows.length) {
      return c.json({
        error: "Conecte a Meta antes de buscar interesses"
      }, 400);
    }

    const params =
      new URLSearchParams({
        type: "adinterest",
        q: termo,
        limit: "12",
        access_token: conn.rows[0].access_token
      });

    const resposta = await fetch(
      `https://graph.facebook.com/v19.0/search?${params}`
    ).then(r => r.json());

    if (resposta.error) {
      return c.json({
        error:
          resposta.error?.error_user_msg ||
          resposta.error?.message ||
          "Erro ao buscar interesses na Meta",
        detalhe: resposta.error
      }, 400);
    }

    return c.json({
      data: Array.isArray(resposta.data)
        ? resposta.data
            .map((interesse: any) => ({
              id: textoOpcional(interesse.id),
              nome: textoOpcional(interesse.name),
              caminho: listaOpcional(interesse.path)
            }))
            .filter((interesse: any) =>
              interesse.id &&
              interesse.nome
            )
        : []
    });
  } catch (err) {
    console.error("ERRO BUSCA INTERESSES:", err);

    return c.json({
      error: "Erro ao buscar interesses Meta"
    }, 500);
  }
});

app.post("/meta/desconectar", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    const conn = await client.query(
      `
      SELECT access_token, conta_anuncios_id
      FROM meta_conexoes
      WHERE usuario_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [user.id]
    );

    const token =
      conn.rows[0]?.access_token;

    if (token) {

      try {
        await fetch(
          `https://graph.facebook.com/v19.0/me/permissions?access_token=${token}`,
          {
            method: "DELETE"
          }
        );
      } catch (err) {
        console.error(
          "ERRO REVOGAR META:",
          err
        );
      }
    }

    await client.query(
      `
      DELETE FROM meta_conexoes
      WHERE usuario_id = $1
      `,
      [user.id]
    );

    return c.json({
      sucesso: true
    });

  } catch (err) {

    console.error(
      "ERRO DESCONECTAR META:",
      err
    );

    return c.json({
      error: "Erro ao desconectar Meta"
    }, 500);
  }
});


// 🔥 WEBHOOK META VERIFY
app.get("/webhook/meta", async (c) => {

  const mode = c.req.query("hub.mode");

  const token = c.req.query("hub.verify_token");

  const challenge = c.req.query("hub.challenge");

  console.log("VERIFY META");

  // 🔐 TOKEN FIXO
  const VERIFY_TOKEN =
    Bun.env.META_VERIFY_TOKEN;

  if (
    mode === "subscribe" &&
    token === VERIFY_TOKEN
  ) {

    console.log("WEBHOOK VALIDADO");

    return c.text(challenge);
  }

  return c.text("Erro verify", 403);
});



// 🔥 RECEBER LEADS META
app.post("/webhook/meta", async (c) => {

  try {
    const corpoRaw =
      await c.req.text();

    const assinatura =
      c.req.header("x-hub-signature-256") ||
      c.req.header("X-Hub-Signature-256") ||
      null;

    if (!validarAssinaturaMetaWebhook(assinatura, corpoRaw)) {
      return c.json({ error: "Assinatura Meta invalida" }, 401);
    }

    const body = JSON.parse(corpoRaw || "{}");

    console.log("WEBHOOK META RECEBIDO");

    if (body.entry) {

      for (const entry of body.entry) {

        for (const change of entry.changes || []) {

          if (change.field === "leadgen") {

            const lead = change.value;

            console.log("NOVO LEAD:", lead);

            const leadgen_id = lead.leadgen_id;
            const page_id = lead.page_id;
            const form_id = lead.form_id;

            // 🔍 IDENTIFICA USUÁRIO PELO FORMULÁRIO OU PÁGINA
            let usuarioId: number | null = null;
            let nomeCampanha = "Campanha Meta";
            let contaAnunciosId: string | null = null;

            if (form_id) {
              const campanhaByForm = await client.query(
                `
                SELECT usuario_id, nome, conta_anuncios_id
                FROM campanhas
                WHERE form_id = $1
                LIMIT 1
                `,
                [form_id]
              );

              if (campanhaByForm.rows.length > 0) {
                usuarioId = campanhaByForm.rows[0].usuario_id;
                nomeCampanha = campanhaByForm.rows[0].nome;
                contaAnunciosId = campanhaByForm.rows[0].conta_anuncios_id;
              }
            }

            if (!usuarioId && page_id) {
              const campanhaByPage = await client.query(
                `
                SELECT usuario_id, nome, conta_anuncios_id
                FROM campanhas
                WHERE page_id = $1
                ORDER BY id DESC
                LIMIT 1
                `,
                [page_id]
              );

              if (campanhaByPage.rows.length > 0) {
                usuarioId = campanhaByPage.rows[0].usuario_id;
                nomeCampanha = campanhaByPage.rows[0].nome;
                contaAnunciosId = campanhaByPage.rows[0].conta_anuncios_id;
              }
            }

            if (!usuarioId) {
              console.log(
                "Usuário não identificado para lead",
                leadgen_id,
                "page",
                page_id,
                "form",
                form_id
              );
              continue;
            }

            // 🔐 BUSCA TOKEN DO USUÁRIO CORRETO
            const conn = await client.query(
              `
              SELECT access_token
              FROM meta_conexoes
              WHERE usuario_id = $1
              ORDER BY id DESC
              LIMIT 1
              `,
              [usuarioId]
            );

            if (conn.rows.length === 0) {
              console.log("Sem token para usuário", usuarioId);
              continue;
            }

            const token = conn.rows[0].access_token;

            // 🔄 EVITA DUPLICATA
            const leadExiste = await client.query(
              `SELECT id FROM leads WHERE lead_id = $1`,
              [leadgen_id]
            );

            if (leadExiste.rows.length > 0) {
              console.log("Lead já existe:", leadgen_id);
              continue;
            }

            // 🔥 BUSCA DADOS REAIS DO LEAD
            const leadData = await fetch(
              `https://graph.facebook.com/v19.0/${leadgen_id}?access_token=${token}`
            ).then(r => r.json());

            console.log(
              "LEAD DATA:",
              JSON.stringify(leadData, null, 2)
            );

            // 🔥 CAMPOS
            let nome = null;
            let email = null;
            let telefone = null;
            const respostasQualificacao: any[] = [];
            const criadoEmMeta = leadData.created_time ? new Date(leadData.created_time).toISOString() : null;

            for (const field of leadData.field_data || []) {
              if (field.name === "full_name") {
                nome = field.values?.[0];
              } else if (field.name === "email") {
                email = field.values?.[0];
              } else if (field.name === "phone_number") {
                telefone = field.values?.[0];
              } else {
                respostasQualificacao.push({
                  pergunta: field.name,
                  resposta: field.values?.[0] || ""
                });
              }
            }

            // 💾 SALVA LEAD VINCULADO AO USUÁRIO CORRETO
            await client.query(
              `
              INSERT INTO leads (
                usuario_id,
                lead_id,
                nome,
                email,
                telefone,
                origem,
                status,
                campanha,
                conta_anuncios_id,
                respostas_qualificacao,
                criado_em
              )
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz, NOW()))
              `,
              [
                usuarioId,
                leadgen_id,
                nome || "Lead Facebook",
                email,
                telefone,
                "meta",
                "novo",
                nomeCampanha,
                contaAnunciosId,
                JSON.stringify(respostasQualificacao),
                criadoEmMeta
              ]
            );

            console.log(
              "✅ LEAD SALVO:",
              leadgen_id,
              "usuário:",
              usuarioId
            );
          }
        }
      }
    }

    return c.json({
      sucesso: true
    });

  } catch (err) {

    console.error("WEBHOOK META:", err);

    return c.json({
      error: "Erro webhook"
    }, 500);
  }
});



// 🔌 banco
const client = new Pool({
  connectionString: Bun.env.DATABASE_URL,
  max: Number(Bun.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});


// 🗄️ tabelas
await client.query(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE,
    senha TEXT,
    tipo TEXT DEFAULT 'cliente'
  );
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    nome TEXT,
    telefone TEXT,
    email TEXT,
    usuario_id INTEGER,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS meta_conexoes (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER,
    access_token TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS meta_oauth_states (
    id SERIAL PRIMARY KEY,
    state_hash TEXT NOT NULL UNIQUE,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira_em TIMESTAMP NOT NULL,
    usado_em TIMESTAMP,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

await client.query(`
  CREATE INDEX IF NOT EXISTS idx_meta_oauth_states_hash
  ON meta_oauth_states (state_hash);
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS campanhas (

    id SERIAL PRIMARY KEY,

    usuario_id INTEGER,

    campaign_id TEXT,
    adset_id TEXT,
    ad_id TEXT,
    form_id TEXT,

    page_id TEXT,

    nome TEXT,

    status TEXT DEFAULT 'PAUSED',

    origem TEXT DEFAULT 'plataforma',

    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS lead_historico (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER,
    usuario_id INTEGER,
    tipo TEXT,
    descricao TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expira_em TIMESTAMP NOT NULL,
    usado_em TIMESTAMP,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS password_history (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    senha_hash TEXT NOT NULL,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS chat_conversas (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'aberta',
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS chat_mensagens (
    id SERIAL PRIMARY KEY,
    conversa_id INTEGER NOT NULL REFERENCES chat_conversas(id) ON DELETE CASCADE,
    remetente_id INTEGER,
    remetente_tipo TEXT NOT NULL,
    conteudo TEXT NOT NULL,
    lido BOOLEAN DEFAULT FALSE,
    enviado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS ia_usos (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,
    referencia_tipo TEXT,
    referencia_id TEXT,
    tokens_entrada INTEGER DEFAULT 0,
    tokens_saida INTEGER DEFAULT 0,
    custo_estimado NUMERIC(12, 4) DEFAULT 0,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS ia_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    provedor TEXT DEFAULT 'openai',
    modelo TEXT DEFAULT 'gpt-5-mini',
    status TEXT DEFAULT 'nao_contratado',
    assinatura_status TEXT DEFAULT 'pendente',
    plano_api TEXT DEFAULT 'sob_demanda',
    limite_mensal_requisicoes INTEGER DEFAULT 1000,
    limite_mensal_custo NUMERIC(12, 2) DEFAULT 300,
    custo_mensal_contratado NUMERIC(12, 2) DEFAULT 0,
    ciclo_inicio DATE DEFAULT CURRENT_DATE,
    observacoes TEXT,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

await client.query(`
  INSERT INTO ia_config (id)
  VALUES (1)
  ON CONFLICT (id) DO NOTHING;
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS railway_billing_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    plano TEXT DEFAULT 'pro',
    moeda TEXT DEFAULT 'USD',
    ultimo_pagamento_valor NUMERIC(12, 2) DEFAULT 0,
    ultimo_pagamento_data DATE,
    proxima_fatura_base NUMERIC(12, 2) DEFAULT 20,
    proxima_fatura_data DATE,
    observacoes TEXT,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

await client.query(`
  INSERT INTO railway_billing_config (id)
  VALUES (1)
  ON CONFLICT (id) DO NOTHING;
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS railway_billing_historico (
    id SERIAL PRIMARY KEY,
    ciclo_mes DATE NOT NULL UNIQUE,
    plano TEXT DEFAULT 'pro',
    moeda TEXT DEFAULT 'USD',
    ultimo_pagamento_valor NUMERIC(12, 2) DEFAULT 0,
    ultimo_pagamento_data DATE,
    proxima_fatura_base NUMERIC(12, 2) DEFAULT 20,
    proxima_fatura_data DATE,
    observacoes TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

await client.query(`
  ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS nome TEXT,
    ADD COLUMN IF NOT EXISTS sobrenome TEXT,
    ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT true,
    ADD COLUMN IF NOT EXISTS admin_id INTEGER,
    ADD COLUMN IF NOT EXISTS plano TEXT DEFAULT 'bronze',
    ADD COLUMN IF NOT EXISTS plano_ativado_em TIMESTAMP,
    ADD COLUMN IF NOT EXISTS assinatura_status TEXT DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS assinatura_inicio TIMESTAMP,
    ADD COLUMN IF NOT EXISTS ia_limite_mensal INTEGER DEFAULT 300,
    ADD COLUMN IF NOT EXISTS ia_custo_limite_mensal NUMERIC(12, 2) DEFAULT 120,
    ADD COLUMN IF NOT EXISTS ia_ativo BOOLEAN DEFAULT true,
    ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
`);

await client.query(`
  UPDATE usuarios
  SET plano = CASE
    WHEN LOWER(plano) IN ('bronze', 'prata', 'ouro') THEN LOWER(plano)
    ELSE 'bronze'
  END
  WHERE plano IS NULL
  OR plano <> LOWER(plano)
  OR LOWER(plano) NOT IN ('bronze', 'prata', 'ouro');
`);

await client.query(`
  ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS lead_id TEXT,
    ADD COLUMN IF NOT EXISTS conta_anuncios_id TEXT,
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'novo',
    ADD COLUMN IF NOT EXISTS origem TEXT DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS campanha TEXT,
    ADD COLUMN IF NOT EXISTS observacao TEXT,
    ADD COLUMN IF NOT EXISTS score TEXT,
    ADD COLUMN IF NOT EXISTS score_manual TEXT,
    ADD COLUMN IF NOT EXISTS motivo_perda TEXT,
    ADD COLUMN IF NOT EXISTS respostas_qualificacao JSONB;
`);

await client.query(`
  ALTER TABLE meta_conexoes
    ADD COLUMN IF NOT EXISTS ultimo_sync TIMESTAMP,
    ADD COLUMN IF NOT EXISTS conta_anuncios_id TEXT;
`);

await client.query(`
  ALTER TABLE campanhas
    ADD COLUMN IF NOT EXISTS adset_id TEXT,
    ADD COLUMN IF NOT EXISTS ad_id TEXT,
    ADD COLUMN IF NOT EXISTS form_id TEXT,
    ADD COLUMN IF NOT EXISTS page_id TEXT,
    ADD COLUMN IF NOT EXISTS conta_anuncios_id TEXT,
    ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP,
    ADD COLUMN IF NOT EXISTS configuracoes_avancadas JSONB,
    ADD COLUMN IF NOT EXISTS encaminhada_para_usuario_id INTEGER,
    ADD COLUMN IF NOT EXISTS encaminhada_em TIMESTAMP;
`);

await client.query(`
  CREATE INDEX IF NOT EXISTS idx_usuarios_email
    ON usuarios(email);
  CREATE INDEX IF NOT EXISTS idx_leads_usuario_id
    ON leads(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_leads_lead_id
    ON leads(lead_id);
  CREATE INDEX IF NOT EXISTS idx_campanhas_usuario_id
    ON campanhas(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_campanhas_conta_anuncios_id
    ON campanhas(conta_anuncios_id);
  CREATE INDEX IF NOT EXISTS idx_campanhas_encaminhada_usuario_id
    ON campanhas(encaminhada_para_usuario_id);
  CREATE INDEX IF NOT EXISTS idx_meta_conexoes_usuario_id
    ON meta_conexoes(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_leads_conta_anuncios_id
    ON leads(conta_anuncios_id);
  CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash
    ON password_reset_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_usuario
    ON password_reset_tokens(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_password_history_usuario
    ON password_history(usuario_id, criado_em DESC);
  CREATE INDEX IF NOT EXISTS idx_ia_usos_usuario_data
    ON ia_usos(usuario_id, criado_em DESC);
`);

/* =========================
   🔐 LOGIN
========================= */

app.post("/auth/solicitar-reset-senha", async (c) => {
  const limite =
    limitarRequisicao(c, "reset-solicitar", 5, 60 * 60 * 1000);

  if (limite) return limite;

  const conn = await client.connect();
  try {
    const { email } = await c.req.json();

    if (!email) {
      return c.json({
        error: "Email obrigatorio"
      }, 400);
    }

    const usuario = await conn.query(
      `
      SELECT id, email, nome
      FROM usuarios
      WHERE LOWER(email) = LOWER($1)
      AND COALESCE(ativo, true) = true
      LIMIT 1
      `,
      [email]
    );

    const user = usuario.rows[0];

    if (user) {
      const token = gerarTokenResetSenha();
      const tokenHash = hashTokenResetSenha(token);
      const resetUrl =
        `${obterFrontendUrl()}/?reset_token=${token}`;

      console.log("[RESET] gerando token para usuario", user.id, "hash:", tokenHash.slice(0, 12) + "...");

      await conn.query("BEGIN");

      await conn.query(
        `
        UPDATE password_reset_tokens
        SET usado_em = NOW()
        WHERE usuario_id = $1
        AND usado_em IS NULL
        `,
        [user.id]
      );

      await conn.query(
        `
        INSERT INTO password_reset_tokens (
          usuario_id,
          token_hash,
          expira_em
        )
        VALUES (
          $1,
          $2,
          NOW() + ($3 || ' minutes')::interval
        )
        `,
        [
          user.id,
          tokenHash,
          RESET_PASSWORD_TTL_MINUTES
        ]
      );

      await conn.query("COMMIT");

      await enviarEmailResetSenha(
        user.email,
        user.nome,
        resetUrl
      );

      console.log("[RESET] email enviado para", user.email);
    }

    return c.json({
      success: true,
      message: "Se o email estiver cadastrado, enviaremos um link para troca de senha."
    });

  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});

    console.error("RESET REQUEST ERROR:", err);

    const mensagem =
      err instanceof Error &&
      err.message === "RESEND_API_KEY nao configurada"
        ? "Serviço de email não configurado. Configure RESEND_API_KEY no Railway."
        : err instanceof Error &&
          err.message === "RESEND_EMAIL_SEND_FAILED"
        ? "Não foi possível enviar o email de troca de senha. Verifique RESEND_FROM_EMAIL e o domínio no Resend."
        : "Erro ao solicitar troca de senha";

    return c.json({
      error: mensagem
    }, 500);
  } finally {
    conn.release();
  }
});

app.get("/auth/validar-reset-senha", async (c) => {
  try {
    const limite =
      limitarRequisicao(c, "reset-validar", 60, 60 * 1000);

    if (limite) return limite;

    const token = c.req.query("token");

    if (!token) {
      return c.json({
        valido: false,
        error: "Token obrigatorio"
      }, 400);
    }

    const tokenHash = hashTokenResetSenha(token);
    console.log("[RESET VALIDAR] token recebido (primeiros 12):", token.slice(0, 12), "hash:", tokenHash.slice(0, 12) + "...");

    const resetToken =
      await buscarResetTokenValido(token);

    if (!resetToken) {
      const dbCheck = await client.query(
        `SELECT id, token_hash, usado_em, expira_em FROM password_reset_tokens ORDER BY id DESC LIMIT 3`
      );
      console.error("[RESET VALIDAR] token NAO encontrado. Ultimos tokens no banco:", dbCheck.rows.map((r: any) => ({
        id: r.id,
        hash_inicio: String(r.token_hash).slice(0, 12),
        usado_em: r.usado_em,
        expira_em: r.expira_em
      })));
      return c.json({
        valido: false,
        error: "Link invalido ou expirado"
      }, 400);
    }

    return c.json({
      valido: true,
      expira_em: resetToken.expira_em
    });

  } catch (err) {
    console.error(
      "VALIDATE RESET PASSWORD ERROR:",
      err
    );

    return c.json({
      valido: false,
      error: "Erro ao validar link"
    }, 500);
  }
});

app.post("/auth/verificar-reset-senha", async (c) => {
  try {
    const limite =
      limitarRequisicao(c, "reset-verificar", 20, 15 * 60 * 1000);

    if (limite) return limite;

    const { token, nova_senha } = await c.req.json();

    if (!token || !nova_senha) {
      return c.json({
        forte: false,
        historico_ok: false,
        error: "Token e nova senha sao obrigatorios"
      }, 400);
    }

    const resetToken =
      await buscarResetTokenValido(token);

    if (!resetToken) {
      return c.json({
        forte: false,
        historico_ok: false,
        error: "Link invalido ou expirado"
      }, 400);
    }

    const forte = SENHA_FORTE.test(nova_senha);
    const reutilizada =
      await senhaJaFoiUsadaRecentemente(
        resetToken.usuario_id,
        nova_senha
      );

    return c.json({
      forte,
      historico_ok: !reutilizada,
      reutilizada
    });

  } catch (err) {
    console.error("VERIFY RESET PASSWORD ERROR:", err);

    return c.json({
      forte: false,
      historico_ok: false,
      error: "Erro ao verificar senha"
    }, 500);
  }
});

app.post("/auth/reset-senha", async (c) => {
  const limite =
    limitarRequisicao(c, "reset-confirmar", 10, 15 * 60 * 1000);

  if (limite) return limite;

  const conn = await client.connect();
  try {
    const { token, nova_senha } = await c.req.json();

    if (!token || !nova_senha) {
      return c.json({
        error: "Token e nova senha sao obrigatorios"
      }, 400);
    }

    if (!SENHA_FORTE.test(nova_senha)) {
      return c.json({
        error: "Senha fraca. Use maiuscula, minuscula, numero e simbolo."
      }, 400);
    }

    const resetToken =
      await buscarResetTokenValido(token);

    if (!resetToken) {
      return c.json({
        error: "Link invalido ou expirado"
      }, 400);
    }

    if (
      await senhaJaFoiUsadaRecentemente(
        resetToken.usuario_id,
        nova_senha
      )
    ) {
      return c.json({
        error: "Esta senha ja foi usada recentemente. Escolha uma senha diferente das ultimas 10."
      }, 400);
    }

    await conn.query("BEGIN");

    const usuarioAtual = await conn.query(
      `
      SELECT senha
      FROM usuarios
      WHERE id = $1
      FOR UPDATE
      `,
      [resetToken.usuario_id]
    );

    await registrarSenhaAnterior(
      conn,
      resetToken.usuario_id,
      usuarioAtual.rows[0]?.senha
    );

    await conn.query(
      `
      UPDATE usuarios
      SET senha = $1
      WHERE id = $2
      `,
      [
        await gerarHashSenha(nova_senha),
        resetToken.usuario_id
      ]
    );

    await conn.query(
      `
      UPDATE password_reset_tokens
      SET usado_em = NOW()
      WHERE usuario_id = $1
      AND usado_em IS NULL
      `,
      [resetToken.usuario_id]
    );

    await conn.query("COMMIT");

    return c.json({
      success: true,
      message: "Senha alterada com sucesso"
    });

  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});

    console.error("RESET PASSWORD ERROR:", err);

    return c.json({
      error: "Erro ao alterar senha"
    }, 500);
  } finally {
    conn.release();
  }
});

app.get("/login-test", async (c) => {
  if (Bun.env.ALLOW_LOGIN_TEST !== "true") {
    return c.json({ error: "Rota desativada" }, 404);
  }

  try {
    const email = c.req.query("email");
    const senha = c.req.query("senha");

    if (!email || !senha) {
      return c.json({ error: "Email e senha obrigatórios" }, 400);
    }

    const result = await client.query(
      `
      SELECT id, email, senha, tipo, nome, sobrenome, plano
      FROM usuarios
      WHERE email=$1
      AND COALESCE(ativo, true) = true
      `,
      [email]
    );

    const user = result.rows[0];

    if (!user || !(await senhaConfere(senha, user.senha))) {
      return c.json({ error: "Login inválido" }, 401);
    }

    await atualizarSenhaLegadaSePreciso(
      user.id,
      senha,
      user.senha
    );

    const token = criarTokenUsuario(user);

    return c.json({
      message: "Login OK",
      token,
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return c.json({ error: "Erro interno" }, 500);
  }
});

app.post("/login", async (c) => {
  const limite =
    limitarRequisicao(c, "login", 10, 15 * 60 * 1000);

  if (limite) return limite;

  const { email, senha } = await c.req.json();

  const result = await client.query(
    `
    SELECT id, email, senha, tipo, nome, sobrenome, plano
    FROM usuarios
    WHERE email=$1
    AND COALESCE(ativo, true) = true
    `,
    [email]
  );

  const user = result.rows[0];

  if (!user || !(await senhaConfere(senha, user.senha))) {
    return c.json({ error: "Login inválido" }, 401);
  }

  await atualizarSenhaLegadaSePreciso(
    user.id,
    senha,
    user.senha
  );

  const token = criarTokenUsuario(user);

  return c.json({
    message: "Login OK",
    token
  });
});

app.get("/usuarios/me/plano", authMiddleware, async (c) => {
  const user: any = c.get("user");

  const uso = await client.query(
    `
    SELECT
      COUNT(*) AS uso_mes,
      COALESCE(SUM(custo_estimado), 0) AS custo_mes
    FROM ia_usos
    WHERE usuario_id = $1
    AND criado_em >= date_trunc('month', CURRENT_DATE)
    `,
    [user.id]
  );

  return c.json({
    plano: normalizarPlano(user.plano),
    tipo: user.tipo,
    acesso_total: false,
    recursos: obterRecursosPlano(user.plano),
    ia: {
      uso_mes: Number(uso.rows[0]?.uso_mes || 0),
      custo_mes: Number(uso.rows[0]?.custo_mes || 0),
      limite_mensal: Number(user.ia_limite_mensal || 300),
      custo_limite_mensal: Number(user.ia_custo_limite_mensal || 120)
    }
  });
});

app.put("/usuarios/me/senha", authMiddleware, async (c) => {
  const conn = await client.connect();

  try {

    const user: any = c.get("user");

    const { senha_atual, nova_senha } =
      await c.req.json();

    if (!senha_atual || !nova_senha) {
      return c.json({
        error: "Senha atual e nova senha são obrigatórias"
      }, 400);
    }

    const senhaForte =
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#._-]).{8,}$/;

    if (!senhaForte.test(nova_senha)) {
      return c.json({
        error: "A nova senha precisa ter no mínimo 8 caracteres, letra maiúscula, minúscula, número e símbolo."
      }, 400);
    }

    const atual = await client.query(
      `
      SELECT id, senha
      FROM usuarios
      WHERE id = $1
      `,
      [user.id]
    );

    const usuarioAtual = atual.rows[0];

    if (
      !usuarioAtual ||
      !(await senhaConfere(senha_atual, usuarioAtual.senha))
    ) {
      return c.json({
        error: "Senha atual incorreta"
      }, 400);
    }

    if (
      await senhaJaFoiUsadaRecentemente(
        user.id,
        nova_senha
      )
    ) {
      return c.json({
        error: "Esta senha ja foi usada recentemente. Escolha uma senha diferente das ultimas 10."
      }, 400);
    }

    const novaSenhaHash = await gerarHashSenha(nova_senha);

    await conn.query("BEGIN");

    await registrarSenhaAnterior(
      conn,
      user.id,
      usuarioAtual.senha
    );

    await conn.query(
      `
      UPDATE usuarios
      SET senha = $1
      WHERE id = $2
      `,
      [novaSenhaHash, user.id]
    );

    await conn.query("COMMIT");

    return c.json({
      sucesso: true
    });

  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});

    console.error("ERRO TROCAR SENHA:", err);

    return c.json({
      error: "Erro ao trocar senha"
    }, 500);
  } finally {
    conn.release();
  }
});


/* =========================
   📊 LEADS
========================= */

/* =========================
   📢 CAMPANHAS
========================= */

// 🔹 listar campanhas
app.get("/campanhas", authMiddleware, async (c) => {

  try {

    const user = c.get("user");

    console.log("USER:", user.id);

    const contaAnunciosId =
      await obterContaAnunciosSelecionadaIdUsuario(
        user.id
      );

    if (!contaAnunciosId) {
      return c.json([]);
    }

    const campanhas = await client.query(
      `
      SELECT
        c.*,
        dono.email AS criado_por_email,
        dono.nome AS criado_por_nome,
        dono.sobrenome AS criado_por_sobrenome,
        corretor.email AS corretor_encaminhado_email,
        corretor.nome AS corretor_encaminhado_nome,
        corretor.sobrenome AS corretor_encaminhado_sobrenome
      FROM campanhas c
      INNER JOIN usuarios dono
        ON dono.id = c.usuario_id
      LEFT JOIN usuarios corretor
        ON corretor.id = c.encaminhada_para_usuario_id
      WHERE
        (
          c.usuario_id = $1
          OR c.encaminhada_para_usuario_id = $1
        )
        AND c.conta_anuncios_id = $2
      ORDER BY c.id DESC
      `,
      [user.id, contaAnunciosId]
    );

    console.log("CAMPANHAS:", campanhas.rows);

    return c.json(campanhas.rows);

  } catch (err) {

    console.error("ERRO CAMPANHAS:", err);

    return c.json({
      error: "Erro ao buscar campanhas"
    }, 500);
  }
});

app.get("/campanhas/corretores-vinculados", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    if (
      user.tipo !== "admin_corretor" &&
      user.tipo !== "super_admin"
    ) {
      return c.json({
        error: "Acesso restrito a administradores"
      }, 403);
    }

    const filtroVinculo =
      user.tipo === "admin_corretor"
        ? "AND admin_id = $1"
        : "";

    const valores =
      user.tipo === "admin_corretor"
        ? [user.id]
        : [];

    const result = await client.query(
      `
      SELECT
        id,
        email,
        nome,
        sobrenome
      FROM usuarios
      WHERE tipo = 'corretor'
      ${filtroVinculo}
      AND COALESCE(ativo, true) = true
      ORDER BY nome NULLS LAST, email ASC
      `,
      valores
    );

    return c.json({
      corretores: result.rows
    });

  } catch (err) {

    console.error(
      "ERRO CORRETORES CAMPANHA:",
      err
    );

    return c.json({
      error: "Erro ao buscar corretores vinculados"
    }, 500);
  }
});

app.post("/campanhas/:id/encaminhar", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    if (
      user.tipo !== "admin_corretor" &&
      user.tipo !== "super_admin"
    ) {
      return c.json({
        error: "Apenas administradores podem encaminhar campanhas"
      }, 403);
    }

    const campanhaId =
      Number(c.req.param("id"));

    const body =
      await c.req.json();

    const corretorId =
      body.corretor_id
        ? Number(body.corretor_id)
        : null;

    const campanha = await client.query(
      `
      SELECT id
      FROM campanhas
      WHERE id = $1
      AND usuario_id = $2
      LIMIT 1
      `,
      [campanhaId, user.id]
    );

    if (!campanha.rows.length) {
      return c.json({
        error: "Campanha não encontrada para este Admin Corretor"
      }, 404);
    }

    if (corretorId) {

      const corretor =
        user.tipo === "admin_corretor"
          ? await client.query(
              `
              SELECT id
              FROM usuarios
              WHERE id = $1
              AND admin_id = $2
              AND tipo = 'corretor'
              AND COALESCE(ativo, true) = true
              LIMIT 1
              `,
              [corretorId, user.id]
            )
          : await client.query(
              `
              SELECT id
              FROM usuarios
              WHERE id = $1
              AND tipo = 'corretor'
              AND COALESCE(ativo, true) = true
              LIMIT 1
              `,
              [corretorId]
            );

      if (!corretor.rows.length) {
        return c.json({
          error: "Selecione um corretor vinculado e ativo"
        }, 400);
      }
    }

    const update = await client.query(
      `
      UPDATE campanhas
      SET
        encaminhada_para_usuario_id = $1,
        encaminhada_em = CASE
          WHEN $1::integer IS NULL THEN NULL
          ELSE NOW()
        END
      WHERE id = $2
      AND usuario_id = $3
      RETURNING id, encaminhada_para_usuario_id
      `,
      [corretorId, campanhaId, user.id]
    );

    return c.json({
      sucesso: true,
      campanha: update.rows[0]
    });

  } catch (err) {

    console.error(
      "ERRO ENCAMINHAR CAMPANHA:",
      err
    );

    return c.json({
      error: "Erro ao encaminhar campanha"
    }, 500);
  }
});

// 📊 métricas reais das campanhas
app.get("/meta/metricas-campanhas", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    const conn = await client.query(
      `
      SELECT access_token, conta_anuncios_id
      FROM meta_conexoes
      WHERE usuario_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [user.id]
    );

    const token =
      conn.rows[0]?.access_token || null;

    const contaAnunciosId =
      conn.rows[0]?.conta_anuncios_id || null;

    const campanhas = await client.query(
      `
      SELECT
        c.*,
        dono.email AS criado_por_email,
        dono.nome AS criado_por_nome,
        dono.sobrenome AS criado_por_sobrenome,
        corretor.email AS corretor_encaminhado_email,
        corretor.nome AS corretor_encaminhado_nome,
        corretor.sobrenome AS corretor_encaminhado_sobrenome
      FROM campanhas c
      INNER JOIN usuarios dono
        ON dono.id = c.usuario_id
      LEFT JOIN usuarios corretor
        ON corretor.id = c.encaminhada_para_usuario_id
      WHERE
        (
          c.usuario_id = $1
          OR c.encaminhada_para_usuario_id = $1
        )
        AND (
          $2::text IS NULL
          OR c.conta_anuncios_id = $2
        )
      ORDER BY c.id DESC
      `,
      [user.id, contaAnunciosId]
    );

    const metricas = [];

    for (const campanha of campanhas.rows) {

      let dados: any = {};
      let grafico: any[] = [];
      let metaDisponivel = false;
      let erroMeta: string | null = null;

      if (
        token &&
        campanha.campaign_id &&
        String(campanha.status || "").toUpperCase() !== "DELETED"
      ) {
        try {
          const insights = await fetch(
            `https://graph.facebook.com/v19.0/${campanha.campaign_id}/insights?fields=impressions,clicks,spend,cpc,ctr,reach,actions,cost_per_action_type&time_increment=1&date_preset=last_7d&access_token=${token}`
          ).then(r => r.json());

          if (insights.error) {
            erroMeta =
              insights.error.message ||
              "Métricas indisponíveis na Meta";
          } else {
            dados = insights.data?.[0] || {};

            grafico =
              insights.data?.map((d: any) => ({
                data: d.date_start,
                clicks: Number(d.clicks || 0),
                ctr: Number(d.ctr || 0),
                gasto: Number(d.spend || 0),
                impressoes: Number(d.impressions || 0)
              })) || [];

            metaDisponivel = true;
          }
        } catch {
          erroMeta = "Métricas indisponíveis na Meta";
        }
      }

      // ✅ LEADS REAIS DO BANCO
      const leadsBanco = await client.query(
        `
        SELECT COUNT(*) AS total
        FROM leads
        WHERE usuario_id = $1
        AND campanha = $2
        AND conta_anuncios_id = $3
        `,
        [
          user.id,
          campanha.nome,
          campanha.conta_anuncios_id
        ]
      );

      const totalLeadsBanco =
        Number(leadsBanco.rows[0]?.total || 0);

      metricas.push({
        id: campanha.id,
        nome: campanha.nome,
        status: campanha.status,
        origem: campanha.origem,
        campaign_id: campanha.campaign_id,
        criada_por_usuario_id: campanha.usuario_id,
        criada_por_email: campanha.criado_por_email,
        criada_por_nome:
          [
            campanha.criado_por_nome,
            campanha.criado_por_sobrenome
          ].filter(Boolean).join(" ") || null,
        encaminhada_para_usuario_id:
          campanha.encaminhada_para_usuario_id || null,
        corretor_encaminhado_email:
          campanha.corretor_encaminhado_email || null,
        corretor_encaminhado_nome:
          [
            campanha.corretor_encaminhado_nome,
            campanha.corretor_encaminhado_sobrenome
          ].filter(Boolean).join(" ") || null,
        recebida_por_encaminhamento:
          Number(campanha.encaminhada_para_usuario_id) ===
          Number(user.id),
        configuracoes_avancadas:
          campanha.configuracoes_avancadas || {},

        impressoes: dados.impressions || 0,
        cliques: dados.clicks || 0,
        alcance: dados.reach || 0,
        gasto: dados.spend || 0,
        cpc: dados.cpc || 0,
        ctr: dados.ctr || 0,

        // 🔥 agora vem da sua plataforma
        leads: totalLeadsBanco,

        grafico,
        criado_em: campanha.criado_em,
        metricas_origem: metaDisponivel ? "meta" : "local",
        meta_disponivel: metaDisponivel,
        erro_meta: erroMeta
      });
    }

    return c.json(metricas);

  } catch (err) {

    console.error("ERRO MÉTRICAS:", err);

    return c.json({
      error: "Erro ao buscar métricas"
    }, 500);
  }
});

// 🔄 sincroniza campanhas + leads da Meta
app.get("/meta/performance-diaria", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    const periodoParam =
      String(c.req.query("periodo") || "semanal")
        .toLowerCase();

    const periodo =
      ["semanal", "mensal", "anual"].includes(periodoParam)
        ? periodoParam
        : "semanal";

    const dias =
      periodo === "anual"
        ? 365
        : periodo === "mensal"
        ? 30
        : 7;

    const conn = await client.query(
      `
      SELECT access_token, conta_anuncios_id
      FROM meta_conexoes
      WHERE usuario_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [user.id]
    );

    if (conn.rows.length === 0) {
      return c.json({
        error: "Meta nao conectada"
      }, 400);
    }

    const token = conn.rows[0].access_token;

    const contaAds =
      await obterContaAnuncios(
        token,
        conn.rows[0].conta_anuncios_id
      );

    if (!contaAds) {
      return c.json({
        error: "Nenhuma conta de anuncios encontrada"
      }, 400);
    }

    const adAccountId = contaAds.id;

    const inicio = new Date();
    inicio.setDate(inicio.getDate() - (dias - 1));
    inicio.setHours(0, 0, 0, 0);

    const fim = new Date();
    fim.setHours(23, 59, 59, 999);

    const since =
      inicio.toISOString().slice(0, 10);

    const until =
      fim.toISOString().slice(0, 10);

    const timeRange =
      encodeURIComponent(
        JSON.stringify({
          since,
          until
        })
      );

    const insights = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/insights?fields=spend,actions,impressions,clicks,reach&time_increment=1&time_range=${timeRange}&access_token=${token}`
    ).then(r => r.json());

    if (insights.error) {
      return c.json({
        error: "Erro ao buscar performance na Meta",
        detalhe: insights.error
      }, 400);
    }

    const leadsBanco = await client.query(
      `
      SELECT
        DATE(criado_em) AS dia,
        COUNT(*) AS total
      FROM leads
      WHERE usuario_id = $1
      AND conta_anuncios_id = $2
      AND criado_em >= $3
      GROUP BY DATE(criado_em)
      `,
      [
        user.id,
        adAccountId,
        inicio
      ]
    );

    const leadsBancoPorDia = new Map(
      leadsBanco.rows.map((row: any) => [
        new Date(row.dia)
          .toISOString()
          .slice(0, 10),
        Number(row.total || 0)
      ])
    );

    const metaPorDia = new Map(
      (insights.data || []).map((linha: any) => [
        linha.date_start,
        linha
      ])
    );

    const datasPeriodo = Array.from(
      { length: dias },
      (_, index) => {
        const data = new Date(inicio);
        data.setDate(inicio.getDate() + index);
        return data.toISOString().slice(0, 10);
      }
    );

    const diasPerformance = datasPeriodo
      .map((data) => {
        const linha: any =
          metaPorDia.get(data) || {};
        const gasto =
          Number(linha.spend || 0);
        const leadsMeta =
          extrairLeadsActionsMeta(linha.actions || []);
        const leadsPlataforma =
          leadsBancoPorDia.get(data) || 0;
        const leads =
          leadsMeta;

        return {
          data,
          gasto,
          leads,
          leads_meta: leadsMeta,
          leads_plataforma: leadsPlataforma,
          custo_por_lead:
            leads > 0
              ? gasto / leads
              : null,
          cliques: Number(linha.clicks || 0),
          impressoes: Number(linha.impressions || 0),
          alcance: Number(linha.reach || 0)
        };
      });

    const totalGasto =
      diasPerformance.reduce(
        (total: number, dia: any) =>
          total + dia.gasto,
        0
      );

    const totalLeads =
      diasPerformance.reduce(
        (total: number, dia: any) =>
          total + dia.leads,
        0
      );

    const hoje =
      diasPerformance[diasPerformance.length - 1] || null;

    const diasAnteriores =
      diasPerformance.slice(0, -1);

    const gastoAnterior =
      diasAnteriores.reduce(
        (total: number, dia: any) =>
          total + dia.gasto,
        0
      );

    const leadsAnteriores =
      diasAnteriores.reduce(
        (total: number, dia: any) =>
          total + dia.leads,
        0
      );

    const mediaCplAnterior =
      leadsAnteriores > 0
        ? gastoAnterior / leadsAnteriores
        : null;

    const cplHoje =
      hoje?.custo_por_lead ?? null;

    const economiaPercentual =
      mediaCplAnterior &&
      cplHoje &&
      cplHoje > 0
        ? ((mediaCplAnterior - cplHoje) / mediaCplAnterior) * 100
        : null;

    const registros =
      periodo === "anual"
        ? Object.values(
            diasPerformance.reduce((acc: any, dia: any) => {
              const chave =
                dia.data.slice(0, 7);

              if (!acc[chave]) {
                acc[chave] = {
                  periodo: chave,
                  data: chave,
                  gasto: 0,
                  leads: 0,
                  leads_meta: 0,
                  leads_plataforma: 0,
                  cliques: 0,
                  impressoes: 0,
                  alcance: 0,
                  custo_por_lead: null
                };
              }

              acc[chave].gasto += dia.gasto;
              acc[chave].leads += dia.leads;
              acc[chave].leads_meta += dia.leads_meta;
              acc[chave].leads_plataforma += dia.leads_plataforma;
              acc[chave].cliques += dia.cliques;
              acc[chave].impressoes += dia.impressoes;
              acc[chave].alcance += dia.alcance;
              acc[chave].custo_por_lead =
                acc[chave].leads > 0
                  ? acc[chave].gasto / acc[chave].leads
                  : null;

              return acc;
            }, {})
          )
        : diasPerformance;

    return c.json({
      conta_anuncios: {
        id: contaAds.id,
        nome: contaAds.name,
        moeda: contaAds.currency || "BRL"
      },
      periodo,
      periodo_dias: dias,
      periodo_inicio: since,
      periodo_fim: until,
      agrupamento:
        periodo === "anual"
          ? "mensal"
          : "diario",
      resumo: {
        gasto_total: totalGasto,
        leads_total: totalLeads,
        custo_por_lead_medio:
          totalLeads > 0
            ? totalGasto / totalLeads
            : null,
        hoje,
        media_cpl_anterior: mediaCplAnterior,
        economia_percentual: economiaPercentual,
        status:
          economiaPercentual === null
            ? "dados_insuficientes"
            : economiaPercentual >= 0
            ? "melhor_que_media"
            : "acima_da_media"
      },
      dias: diasPerformance,
      registros
    });

  } catch (err: any) {

    console.error(
      "ERRO PERFORMANCE DIARIA:",
      err
    );

    return c.json({
      error: "Erro ao buscar performance diaria",
      detalhe: err?.message || err
    }, 500);
  }
});

app.get("/meta/performance-diaria/:data/campanhas", authMiddleware, async (c: any) => {
  try {
    const user: any = c.get("user");
    const data = c.req.param("data");

    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      return c.json({ error: "Data invalida. Use YYYY-MM-DD" }, 400);
    }

    const conn = await client.query(
      `SELECT access_token, conta_anuncios_id FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1`,
      [user.id]
    );

    if (conn.rows.length === 0) {
      return c.json({ error: "Meta nao conectada" }, 400);
    }

    const token = conn.rows[0].access_token;
    const contaAds = await obterContaAnuncios(token, conn.rows[0].conta_anuncios_id);

    if (!contaAds) {
      return c.json({ error: "Conta de anuncios nao encontrada" }, 400);
    }

    const adAccountId = contaAds.id;
    const timeRange = encodeURIComponent(JSON.stringify({ since: data, until: data }));

    const insights = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/insights?fields=campaign_name,campaign_id,spend,actions,clicks,impressions&level=campaign&time_range=${timeRange}&access_token=${token}`
    ).then(r => r.json());

    if (insights.error) {
      return c.json({ error: "Erro ao buscar dados da Meta", detalhe: insights.error }, 400);
    }

    const campanhas = (insights.data || []).map((item: any) => {
      const gasto = Number(item.spend || 0);
      const leads = extrairLeadsActionsMeta(item.actions || []);
      return {
        campaign_id: item.campaign_id,
        nome: item.campaign_name || "Campanha sem nome",
        gasto,
        leads,
        cliques: Number(item.clicks || 0),
        impressoes: Number(item.impressions || 0),
        custo_por_lead: leads > 0 ? gasto / leads : null
      };
    });

    campanhas.sort((a: any, b: any) => b.gasto - a.gasto);

    return c.json({ data, campanhas });

  } catch (err: any) {
    console.error("ERRO CAMPANHAS DIA:", err);
    return c.json({ error: "Erro ao buscar campanhas do dia", detalhe: err?.message }, 500);
  }
});

app.post("/meta/sincronizar-campanhas", authMiddleware, async (c) => {

  const user: any = c.get("user");

  try {

    console.log("USER AUTH:", user);

    if (syncEmAndamento.has(user.id)) {
      return c.json({
        error: "Já existe uma sincronização em andamento para este usuário."
      }, 429);
    }

    syncEmAndamento.add(user.id);

    console.log("USER LOGADO:", user);


    // 🔐 TOKEN META
    const conn = await client.query(
      `
      SELECT access_token, conta_anuncios_id
      FROM meta_conexoes
      WHERE usuario_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [user.id]
    );

    console.log("CONN:", conn.rows);

    if (conn.rows.length === 0) {

      return c.json({
        error: "Meta não conectada"
      }, 400);
    }

    const token = conn.rows[0].access_token;

    // 🔥 CONTA DE ANÚNCIOS
    const contaAds =
      await obterContaAnuncios(
        token,
        conn.rows[0].conta_anuncios_id
      );
    
    if (!contaAds) {
    
      return c.json({
        error: "Nenhuma conta de anúncios encontrada"
      }, 400);
    }
    
    const adAccountId = contaAds.id;

    // 🔥 BUSCA CAMPANHAS
    const campanhasMeta = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/campaigns?fields=id,name,status,effective_status,objective&limit=500&access_token=${token}`
    ).then(r => r.json());

    console.log(
      "META CAMPANHAS:",
      JSON.stringify(campanhasMeta, null, 2)
    );

    console.log("TOTAL META:", campanhasMeta.data?.length);

    if (!campanhasMeta.data) {

      return c.json({
        error: "Nenhuma campanha encontrada",
        detalhe: campanhasMeta
      }, 400);
    }

    // 🔄 SALVA / ATUALIZA CAMPANHAS
    for (const campanha of campanhasMeta.data) {

      const statusFinal =
        campanha.effective_status ||
        campanha.status ||
        "PAUSED";

      const existe = await client.query(
        `
        SELECT id
        FROM campanhas
        WHERE campaign_id = $1
        `,
        [campanha.id]
      );

      if (existe.rows.length > 0) {

        await client.query(
          `
          UPDATE campanhas
          SET
            nome = $1,
            status = $2,
            conta_anuncios_id = $3,
            atualizado_em = NOW()
          WHERE campaign_id = $4
          `,
          [
            campanha.name,
            statusFinal,
            adAccountId,
            campanha.id
          ]
        );

        console.log(
          "♻️ Atualizada:",
          campanha.name
        );

      } else {

        await client.query(
          `
          INSERT INTO campanhas (
            usuario_id,
            campaign_id,
            conta_anuncios_id,
            nome,
            status,
            origem,
            atualizado_em
          )
          VALUES ($1,$2,$3,$4,$5,$6,NOW())
          `,
          [
            user.id,
            campanha.id,
            adAccountId,
            campanha.name,
            statusFinal,
            "meta"
          ]
        );

        console.log(
          "✅ Nova:",
          campanha.name
        );
      }
    }

    // =====================================================
    // 🔥 SINCRONIZA LEADS
    // =====================================================

    // 🔥 BUSCA PÁGINAS
    const paginas = await fetch(
      `https://graph.facebook.com/v19.0/me/accounts?access_token=${token}`
    ).then(r => r.json());

    console.log(
      "PAGINAS META:",
      JSON.stringify(paginas, null, 2)
    );

    for (const pagina of paginas.data || []) {

      console.log("PAGINA:", pagina.name);

      // 🔥 BUSCA FORMULÁRIOS
      const pageToken =
        pagina.access_token;
      
      const forms = await fetch(
        `https://graph.facebook.com/v19.0/${pagina.id}/leadgen_forms?access_token=${pageToken}`
      ).then(r => r.json());

      console.log(
        "FORMS META:",
        Array.isArray(forms.data) ? forms.data.length : 0
      );

      for (const form of forms.data || []) {

        // 🔥 BUSCA CAMPANHA PELO FORM
        const campanhaBanco = await client.query(
          `
          SELECT nome
          FROM campanhas
          WHERE form_id = $1
          AND conta_anuncios_id = $2
          LIMIT 1
          `,
          [form.id, adAccountId]
        );

        if (!campanhaBanco.rows.length) {
          console.log(
            "FORMULARIO SEM CAMPANHA DA CONTA SELECIONADA:",
            form.id
          );
          continue;
        }
        
        const nomeCampanha =
          campanhaBanco.rows[0]?.nome ||
          "Campanha sem vínculo";
        
        console.log("FORM:", form.name);

        // 🔥 BUSCA LEADS
        const leadsMeta = await fetch(
          `https://graph.facebook.com/v19.0/${form.id}/leads?access_token=${pageToken}`
        ).then(r => r.json());

        console.log(
          "LEADS META:",
          Array.isArray(leadsMeta.data) ? leadsMeta.data.length : 0
        );

        for (const lead of leadsMeta.data || []) {

          // 🔥 transforma fields
          const fields: any = {};
          const respostasQualificacao: any[] = [];

          for (const field of lead.field_data || []) {

            fields[field.name] =
              field.values?.[0] || "";

            if (
              ![
                "full_name",
                "email",
                "phone_number"
              ].includes(field.name)
            ) {
              respostasQualificacao.push({
                pergunta: field.name,
                resposta: field.values?.[0] || ""
              });
            }
          }

          // 🔥 evita duplicar lead
          const leadExiste = await client.query(
            `
            SELECT id
            FROM leads
            WHERE lead_id = $1
            `,
            [lead.id]
          );

          if (leadExiste.rows.length > 0) {

            await client.query(
              `
              UPDATE leads
              SET
                campanha = $1,
                respostas_qualificacao = $2,
                conta_anuncios_id = $3
              WHERE lead_id = $4
              AND usuario_id = $5
              `,
              [
                nomeCampanha,
                JSON.stringify(respostasQualificacao),
                adAccountId,
                lead.id,
                user.id
              ]
            );
          
            console.log(
              "♻️ Lead atualizado:",
              lead.id,
              nomeCampanha
            );
          
            continue;
          }

          console.log("FIELDS:", fields);

          // 🔥 salva lead
          await client.query(
            `
            INSERT INTO leads (
              usuario_id,
              lead_id,
              nome,
              email,
              telefone,
              campanha,
              conta_anuncios_id,
              origem,
              status,
              respostas_qualificacao,
              criado_em
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()
            )
            `,
            [
              user.id,
              lead.id,
              fields.full_name || "",
              fields.email || "",
              fields.phone_number || "",
              nomeCampanha,
              adAccountId,
              "meta",
              "novo",
              JSON.stringify(respostasQualificacao)
            ]
          );

          console.log(
            "✅ LEAD SALVO:",
            lead.id
          );
        }
      }
    }

    // 🔥 UPDATE ÚLTIMO SYNC
    await client.query(
      `
      UPDATE meta_conexoes
      SET ultimo_sync = NOW()
      WHERE usuario_id = $1
      `,
      [user.id]
    );
    
    return c.json({
      sucesso: true,
      total: campanhasMeta.data.length
    });

    } catch (err) {

    console.error("ERRO SINCRONIZAR:", err);

    return c.json({
      error: "Erro ao sincronizar campanhas"
    }, 500);

  } finally {

    syncEmAndamento.delete(user.id);
  }
});

app.post("/meta/toggle-campanha", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    const {
      campaign_id,
      status
    } = await c.req.json();

    const contaAnunciosId =
      await obterContaAnunciosSelecionadaIdUsuario(
        user.id
      );

    const campanhaBanco = await client.query(
      `
      SELECT id, adset_id, ad_id
      FROM campanhas
      WHERE campaign_id = $1
      AND (
        usuario_id = $2
        OR encaminhada_para_usuario_id = $2
      )
      AND conta_anuncios_id = $3
      LIMIT 1
      `,
      [campaign_id, user.id, contaAnunciosId]
    );

    if (!campanhaBanco.rows.length) {
      return c.json({
        error: "Campanha não disponível para este usuário"
      }, 404);
    }
    
    const adset_id =
      campanhaBanco.rows[0]?.adset_id;
    
    const ad_id =
      campanhaBanco.rows[0]?.ad_id;
    
    console.log("ADSET:", adset_id);
    
    console.log("AD:", ad_id);

    

    // 🔐 TOKEN
    const conn = await client.query(
      `
      SELECT access_token
      FROM meta_conexoes
      WHERE usuario_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [user.id]
    );

    if (conn.rows.length === 0) {

      return c.json({
        error: "Meta não conectada"
      }, 400);
    }

    const token = conn.rows[0].access_token;

    // 🔥 ALTERA STATUS NA META
    const metaRes = await fetch(
      `https://graph.facebook.com/v19.0/${campaign_id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          status,
          access_token: token
        })
      }
    ).then(r => r.json());


    // 🔥 TOGGLE ADSET
    if (adset_id) {
    
      const adsetRes = await fetch(
        `https://graph.facebook.com/v19.0/${adset_id}`,
        {
          method: "POST",
    
          headers: {
            "Content-Type": "application/json"
          },
    
          body: JSON.stringify({
            status,
            access_token: token
          })
        }
      ).then(r => r.json());
    
      console.log(
        "TOGGLE ADSET:",
        adsetRes
      );
    }

    // 🔥 TOGGLE ANÚNCIO
    if (ad_id) {
    
      const adRes = await fetch(
        `https://graph.facebook.com/v19.0/${ad_id}`,
        {
          method: "POST",
    
          headers: {
            "Content-Type": "application/json"
          },
    
          body: JSON.stringify({
            status,
            access_token: token
          })
        }
      ).then(r => r.json());
    
      console.log(
        "TOGGLE AD:",
        adRes
      );
    }

    

    

    console.log("TOGGLE META:", metaRes);

    if (metaRes.error) {

      return c.json({
        error: metaRes.error.message
      }, 400);
    }

    // 💾 UPDATE LOCAL
    await client.query(
      `
      UPDATE campanhas
      SET status = $1
      WHERE id = $2
      `,
      [status, campanhaBanco.rows[0].id]
    );

    return c.json({
      sucesso: true
    });

  } catch (err) {

    console.error("TOGGLE:", err);

    return c.json({
      error: "Erro ao alterar campanha"
    }, 500);
  }
});


app.post("/meta/excluir-campanha", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    const {
      campaign_id
    } = await c.req.json();

    const contaAnunciosId =
      await obterContaAnunciosSelecionadaIdUsuario(
        user.id
      );

    const campanha = await client.query(
      `
      SELECT id
      FROM campanhas
      WHERE campaign_id = $1
      AND usuario_id = $2
      AND conta_anuncios_id = $3
      LIMIT 1
      `,
      [campaign_id, user.id, contaAnunciosId]
    );

    if (!campanha.rows.length) {
      return c.json({
        error: "Apenas o dono da campanha pode excluí-la"
      }, 403);
    }

    // 🔐 TOKEN
    const conn = await client.query(
      `
      SELECT access_token
      FROM meta_conexoes
      WHERE usuario_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [user.id]
    );

    if (conn.rows.length === 0) {

      return c.json({
        error: "Meta não conectada"
      }, 400);
    }

    const token = conn.rows[0].access_token;

    // 🔥 DELETA NA META
    const metaRes = await fetch(
      `https://graph.facebook.com/v19.0/${campaign_id}`,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          status: "DELETED",
          access_token: token
        })
      }
    ).then(r => r.json());

    console.log("DELETE META:", metaRes);

    if (metaRes.error) {

      return c.json({
        error: metaRes.error.message
      }, 400);
    }

    // 💾 REMOVE LOCAL
    await client.query(
      `
      UPDATE campanhas
      SET status = 'DELETED'
      WHERE id = $1
      `,
      [campanha.rows[0].id]
    );

    return c.json({
      sucesso: true
    });

  } catch (err) {

    console.error("EXCLUIR CAMPANHA:", err);

    return c.json({
      error: "Erro ao excluir campanha"
    }, 500);
  }
});


// 🔹 restaurar campanha excluída no histórico local
app.post("/meta/restaurar-campanha", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    const {
      campaign_id
    } = await c.req.json();

    const campanha = await client.query(
      `
      SELECT id, adset_id, ad_id
      FROM campanhas
      WHERE campaign_id = $1
      AND usuario_id = $2
      AND UPPER(status) = 'DELETED'
      LIMIT 1
      `,
      [campaign_id, user.id]
    );

    if (!campanha.rows.length) {
      return c.json({
        error: "Campanha excluída não encontrada para este usuário"
      }, 404);
    }

    const conn = await client.query(
      `
      SELECT access_token
      FROM meta_conexoes
      WHERE usuario_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [user.id]
    );

    const token =
      conn.rows[0]?.access_token || null;

    let aviso: string | null = null;

    if (token) {
      const idsMeta = [
        campaign_id,
        campanha.rows[0].adset_id,
        campanha.rows[0].ad_id
      ].filter(Boolean);

      for (const idMeta of idsMeta) {
        const metaRes = await fetch(
          `https://graph.facebook.com/v19.0/${idMeta}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              status: "PAUSED",
              access_token: token
            })
          }
        ).then(r => r.json());

        if (metaRes.error && !aviso) {
          aviso =
            "A Meta não permitiu recuperar a campanha original. Ela ficou restaurada apenas na plataforma.";
        }
      }
    } else {
      aviso =
        "Meta não conectada. A campanha foi restaurada apenas no histórico local.";
    }

    await client.query(
      `
      UPDATE campanhas
      SET status = 'PAUSED'
      WHERE id = $1
      `,
      [campanha.rows[0].id]
    );

    return c.json({
      sucesso: true,
      aviso
    });

  } catch (err) {

    console.error("RESTAURAR CAMPANHA:", err);

    return c.json({
      error: "Erro ao restaurar campanha"
    }, 500);
  }
});

// 🔹 criar lead
app.post("/leads", authMiddleware, async (c) => {
  try {
    const body = await c.req.json();
    const user: any = c.get("user");


    if (!body.nome) {
      return c.json({ error: "Nome obrigatório" }, 400);
    }

    await client.query(
      "INSERT INTO leads (nome, telefone, email, usuario_id) VALUES ($1,$2,$3,$4)",
      [body.nome, body.telefone, body.email, user.id]
    );

    return c.json({ message: "Lead salvo com sucesso" });
  } catch (err) {
    console.error("LEAD ERROR:", err);
    return c.json({ error: "Erro ao salvar lead" }, 500);
  }
});

// 🔹 listar leads
app.get("/leads", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    console.log("USER AUTH:", user);

    const contaAnunciosId =
      await obterContaAnunciosSelecionadaIdUsuario(
        user.id
      );

    const result = await client.query(
      `
      SELECT
        id,
        nome,
        telefone,
        email,
        status,
        origem,
        campanha,
        observacao,
        score,
        score_manual,
        motivo_perda,
        respostas_qualificacao,
        criado_em
      FROM leads
      WHERE usuario_id = $1
      AND (
        COALESCE(origem, 'manual') <> 'meta'
        OR conta_anuncios_id = $2
      )
      ORDER BY criado_em DESC
      `,
      [user.id, contaAnunciosId]
    );

    marcarLeadsRecorrentes(result.rows);

    // 🔥 separa por status
    const leads = {
      novos: [],
      primeiro_contato: [],
      em_conversa: [],
      fechado: [],
      perdido: []
    };

    const modeloMLLeads =
      usuarioTemRecurso(
        user,
        "machine_learning_leads"
      )
        ? treinarModeloMLLeads(result.rows)
        : null;
    
    for (const lead of result.rows) {

      // 🔥 SCORE AUTOMÁTICO
      const scoreData =
        calcularScoreLead(lead);
      
      lead.score =
        scoreData.score;
      
      lead.score_base =
        scoreData.base;

      lead.score_pontos =
        scoreData.pontos;

      if (modeloMLLeads) {
        lead.ml_leads =
          preverConversaoMLLead(
            modeloMLLeads,
            lead
          );
        aplicarMLAoScoreLead(lead);
      }

      if (usuarioTemIA(user)) {
        lead.ia_leads =
          gerarAnaliseIAOuroLead(
            lead,
            lead.ml_leads || null
          );
      }
    
      if (
        lead.status === "novo" ||
        !lead.status
      ) {
    
        leads.novos.push(lead);
    
      } else if (lead.status === "primeiro_contato") {
    
        leads.primeiro_contato.push(lead);
    
      } else if (lead.status === "em_conversa") {
    
        leads.em_conversa.push(lead);
    
      } else if (lead.status === "fechado") {
    
        leads.fechado.push(lead);
        
      } else if (lead.status === "perdido") {

          leads.perdido.push(lead);
        }
    }

    return c.json(leads);

  } catch (err) {

    console.error("LIST ERROR:", err);

    return c.json({
      error: "Erro ao buscar leads"
    }, 500);
  }
});




// 🔥 atualizar lead
app.get("/ia/leads/:id", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const limite =
      limitarRequisicao(c, `ia:${user.id}`, 30, 60 * 1000);

    if (limite) return limite;

    if (!usuarioTemIA(user)) {
      return c.json({
        error: "IA disponivel apenas no plano Ouro"
      }, 403);
    }

    if (!user.ia_ativo) {
      return c.json({
        error: "IA desativada para este usuario."
      }, 403);
    }

    const configIA =
      await buscarConfigIA();

    if (configIA?.status !== "contratado") {
      return c.json({
        error: configIA?.status === "pausado"
          ? "Uso da IA pausado pelo administrador."
          : "IA nao configurada pelo administrador."
      }, 403);
    }

    const limiteIA = await validarLimiteIAUsuario(user);

    if (!limiteIA.permitido) {
      return c.json({
        error: limiteIA.motivo
      }, 429);
    }

    const id = c.req.param("id");

    const leadResult = await client.query(
      `
      SELECT
        id,
        nome,
        telefone,
        email,
        status,
        origem,
        campanha,
        observacao,
        score,
        score_manual,
        motivo_perda,
        respostas_qualificacao,
        criado_em
      FROM leads
      WHERE id = $1
      AND usuario_id = $2
      LIMIT 1
      `,
      [id, user.id]
    );

    const lead = leadResult.rows[0];

    if (!lead) {
      return c.json({ error: "Lead nao encontrado" }, 404);
    }

    const todosLeads = await client.query(
      `
      SELECT
        id,
        nome,
        telefone,
        email,
        status,
        origem,
        campanha,
        observacao,
        score,
        score_manual,
        motivo_perda,
        respostas_qualificacao,
        criado_em
      FROM leads
      WHERE usuario_id = $1
      `,
      [user.id]
    );

    marcarLeadsRecorrentes(todosLeads.rows);

    const leadRecorrente =
      todosLeads.rows.find((item: any) =>
        Number(item.id) === Number(lead.id)
      );

    if (leadRecorrente) {
      lead.repetido = leadRecorrente.repetido;
    }

    const modeloML =
      usuarioTemRecurso(user, "machine_learning_leads")
        ? treinarModeloMLLeads(todosLeads.rows)
        : null;

    const scoreData = calcularScoreLead(lead);
    lead.score = scoreData.score;
    lead.score_base = scoreData.base;
    lead.score_pontos = scoreData.pontos;

    const ml =
      modeloML
        ? preverConversaoMLLead(modeloML, lead)
        : null;

    if (ml) {
      lead.ml_leads = ml;
      aplicarMLAoScoreLead(lead);
    }

    let analise =
      gerarAnaliseIAOuroLead(
        lead,
        lead.ml_leads || null
      );

    let usoIA: any = null;

    try {
      usoIA =
        await gerarAnaliseIAOpenAI(
          lead,
          lead.ml_leads || null
        );

      if (usoIA?.analise) {
        analise = usoIA.analise;
      }
    } catch (err) {
      console.error(
        "OPENAI IA LEAD FALLBACK:",
        err
      );
    }

    await registrarUsoIA(
      Number(user.id),
      "analise_lead",
      "lead",
      lead.id,
      usoIA?.custo_estimado ||
        IA_CUSTO_ESTIMADO_PADRAO,
      Number(usoIA?.usage?.input_tokens || 0),
      Number(usoIA?.usage?.output_tokens || 0)
    );

    return c.json({ analise });

  } catch (err) {
    console.error("ERRO IA LEAD:", err);
    return c.json({
      error: "Erro ao gerar analise de IA"
    }, 500);
  }
});

app.put("/leads/:id", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    const id = c.req.param("id");

    const {
      observacao,
      status,
      motivo_perda,
      score_manual
    } = await c.req.json();

    // 🔥 busca lead atual
    const leadAtual = await client.query(
      `
      SELECT
        status,
        observacao
      FROM leads
      WHERE id = $1
      AND usuario_id = $2
      `,
      [id, user.id]
    );

    const statusAntigo =
      leadAtual.rows[0]?.status || "";
    
    const observacaoAntiga =
      leadAtual.rows[0]?.observacao || "";

    const result = await client.query(
      `
      UPDATE leads
      SET
        observacao = $1,
        status = $2,
        motivo_perda = $3,
        score_manual = $4
      WHERE
        id = $5
      AND usuario_id = $6
      RETURNING *
      `,
      [
        observacao,
        status,
        motivo_perda,
        score_manual,
        id,
        user.id
      ]
    );

    // 🔥 HISTÓRICO STATUS
    if (status !== statusAntigo) {
    
      let descricao =
        `Lead movido de "${statusAntigo}" para "${status}"`;
    
      // perdido
      if (
        status === "perdido" &&
        motivo_perda
      ) {
    
        descricao =
          `Lead perdido: ${motivo_perda}`;
      }
    
      // fechado
      if (status === "fechado") {
    
        descricao =
          "Lead marcado como FECHADO";
      }
    
      await client.query(
        `
        INSERT INTO lead_historico (
          lead_id,
          usuario_id,
          tipo,
          descricao
        )
        VALUES ($1,$2,$3,$4)
        `,
        [
          id,
          user.id,
          "status",
          descricao
        ]
      );
    }
    
    // 🔥 HISTÓRICO OBS
    if (
      observacao &&
      observacao !== observacaoAntiga
    ) {
    
      await client.query(
        `
        INSERT INTO lead_historico (
          lead_id,
          usuario_id,
          tipo,
          descricao
        )
        VALUES ($1,$2,$3,$4)
        `,
        [
          id,
          user.id,
          "observacao",
          observacao
        ]
      );
    }

    return c.json({
      success: true,
      lead: result.rows[0]
    });

  } catch (err) {

    console.error("UPDATE LEAD ERROR:", err);

    return c.json({
      error: "Erro ao atualizar lead"
    }, 500);
  }
});



// 🔹 histórico lead
app.get(
  "/leads/:id/historico",
  authMiddleware,
  async (c) => {

    try {

      const user: any =
        c.get("user");

      const id =
        c.req.param("id");

      const result =
        await client.query(
          `
          SELECT
            id,
            tipo,
            descricao,
            criado_em
          FROM lead_historico
          WHERE lead_id = $1
          AND usuario_id = $2
          ORDER BY criado_em DESC
          `,
          [id, user.id]
        );

      return c.json(result.rows);

    } catch (err) {

      console.error(
        "HIST ERROR:",
        err
      );

      return c.json({
        error:
          "Erro ao buscar histórico"
      }, 500);
    }
  }
);



app.get("/admin/ia", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");

    if (user.tipo !== "super_admin") {
      return c.json({ error: "Acesso negado" }, 403);
    }

    const config = await client.query(
      `SELECT * FROM ia_config WHERE id = 1 LIMIT 1`
    );

    const resumo = await client.query(`
      SELECT
        COUNT(DISTINCT u.id) FILTER (WHERE u.plano = 'ouro') AS usuarios_ouro,
        COUNT(DISTINCT u.id) FILTER (
          WHERE u.plano = 'ouro'
          AND COALESCE(u.ativo, true) = true
        ) AS usuarios_ouro_ativos,
        COALESCE(SUM(iu.custo_estimado), 0) AS custo_mes,
        COALESCE(SUM(iu.tokens_entrada), 0) AS tokens_entrada_mes,
        COALESCE(SUM(iu.tokens_saida), 0) AS tokens_saida_mes,
        COUNT(iu.id) AS chamadas_mes
      FROM usuarios u
      LEFT JOIN ia_usos iu
        ON iu.usuario_id = u.id
        AND iu.criado_em >= date_trunc('month', CURRENT_DATE)
    `);

    const usuarios = await client.query(`
      SELECT
        u.id,
        u.email,
        u.nome,
        u.sobrenome,
        u.tipo,
        u.plano,
        u.plano_ativado_em,
        u.assinatura_status,
        u.assinatura_inicio,
        u.ia_limite_mensal,
        u.ia_custo_limite_mensal,
        COALESCE(u.ia_ativo, true) AS ia_ativo,
        COALESCE(COUNT(iu.id), 0) AS chamadas_mes,
        COALESCE(SUM(iu.custo_estimado), 0) AS custo_mes,
        COALESCE(SUM(iu.tokens_entrada), 0) AS tokens_entrada_mes,
        COALESCE(SUM(iu.tokens_saida), 0) AS tokens_saida_mes,
        MAX(iu.criado_em) AS ultimo_uso
      FROM usuarios u
      LEFT JOIN ia_usos iu
        ON iu.usuario_id = u.id
        AND iu.criado_em >= date_trunc('month', CURRENT_DATE)
      WHERE u.plano = 'ouro'
      GROUP BY
        u.id,
        u.email,
        u.nome,
        u.sobrenome,
        u.tipo,
        u.plano,
        u.plano_ativado_em,
        u.assinatura_status,
        u.assinatura_inicio,
        u.ia_limite_mensal,
        u.ia_custo_limite_mensal,
        u.ia_ativo
      ORDER BY u.plano_ativado_em DESC NULLS LAST, u.id ASC
    `);

    const configAtual =
      config.rows[0] || {};
    const modeloAtivo =
      textoOpcional(Bun.env.OPENAI_MODEL) ||
      "gpt-5-mini";

    return c.json({
      config: {
        ...configAtual,
        modelo: modeloAtivo,
        modelo_origem: "railway",
        chave_configurada: Boolean(Bun.env.OPENAI_API_KEY)
      },
      resumo: resumo.rows[0],
      usuarios: usuarios.rows
    });

  } catch (err) {
    console.error("ERRO ADMIN IA:", err);
    return c.json({ error: "Erro ao carregar painel de IA" }, 500);
  }
});

app.put("/admin/ia/config", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");

    if (user.tipo !== "super_admin") {
      return c.json({ error: "Acesso negado" }, 403);
    }

    const body = await c.req.json();

    const result = await client.query(
      `
      UPDATE ia_config
      SET
        provedor = COALESCE($1, provedor),
        modelo = modelo,
        status = COALESCE($2, status),
        assinatura_status = COALESCE($3, assinatura_status),
        plano_api = COALESCE($4, plano_api),
        limite_mensal_requisicoes = COALESCE($5, limite_mensal_requisicoes),
        limite_mensal_custo = COALESCE($6, limite_mensal_custo),
        custo_mensal_contratado = COALESCE($7, custo_mensal_contratado),
        observacoes = COALESCE($8, observacoes),
        atualizado_em = NOW()
      WHERE id = 1
      RETURNING *
      `,
      [
        body.provedor || null,
        body.status || null,
        body.assinatura_status || null,
        body.plano_api || null,
        Number.isFinite(Number(body.limite_mensal_requisicoes))
          ? Number(body.limite_mensal_requisicoes)
          : null,
        Number.isFinite(Number(body.limite_mensal_custo))
          ? Number(body.limite_mensal_custo)
          : null,
        Number.isFinite(Number(body.custo_mensal_contratado))
          ? Number(body.custo_mensal_contratado)
          : null,
        body.observacoes || null
      ]
    );

    return c.json({
      sucesso: true,
      config: result.rows[0]
    });

  } catch (err) {
    console.error("ERRO ADMIN IA CONFIG:", err);
    return c.json({ error: "Erro ao salvar configuracao de IA" }, 500);
  }
});

app.put("/admin/usuarios/:id/ia-limites", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");

    if (user.tipo !== "super_admin") {
      return c.json({ error: "Acesso negado" }, 403);
    }

    const id = c.req.param("id");
    const body = await c.req.json();

    await client.query(
      `
      UPDATE usuarios
      SET
        ia_limite_mensal = $1,
        ia_custo_limite_mensal = $2,
        assinatura_status = COALESCE($3, assinatura_status),
        ia_ativo = COALESCE($4, ia_ativo)
      WHERE id = $5
      `,
      [
        Math.max(0, Number(body.ia_limite_mensal || 0)),
        Math.max(0, Number(body.ia_custo_limite_mensal || 0)),
        body.assinatura_status || null,
        typeof body.ia_ativo === "boolean"
          ? body.ia_ativo
          : null,
        id
      ]
    );

    return c.json({ sucesso: true });

  } catch (err) {
    console.error("ERRO LIMITES IA USUARIO:", err);
    return c.json({ error: "Erro ao atualizar limites de IA" }, 500);
  }
});

app.get("/admin/usuarios", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    if (user.tipo !== "super_admin") {
      return c.json({
        error: "Acesso negado"
      }, 403);
    }

    const result = await client.query(`
      SELECT
        u.id,
        u.email,
        u.tipo,
        u.plano,
        u.plano_ativado_em,
        u.assinatura_status,
        u.assinatura_inicio,
        u.ia_limite_mensal,
        u.ia_custo_limite_mensal,
        COALESCE(u.ia_ativo, true) AS ia_ativo,
        u.admin_id,
        admin.email AS admin_email,
        COALESCE(u.ativo, true) AS ativo,
        COALESCE(ia.uso_mes, 0) AS ia_uso_mes,
        COALESCE(ia.custo_mes, 0) AS ia_custo_mes,
        COUNT(DISTINCT c.id) AS campanhas,
        COUNT(DISTINCT l.id) AS leads
      FROM usuarios u
      LEFT JOIN usuarios admin
        ON admin.id = u.admin_id
      LEFT JOIN (
        SELECT
          usuario_id,
          COUNT(*) AS uso_mes,
          COALESCE(SUM(custo_estimado), 0) AS custo_mes
        FROM ia_usos
        WHERE criado_em >= date_trunc('month', CURRENT_DATE)
        GROUP BY usuario_id
      ) ia
        ON ia.usuario_id = u.id
      LEFT JOIN campanhas c
        ON c.usuario_id = u.id
      LEFT JOIN leads l
        ON l.usuario_id = u.id
      GROUP BY
        u.id,
        u.email,
        u.tipo,
        u.plano,
        u.plano_ativado_em,
        u.assinatura_status,
        u.assinatura_inicio,
        u.ia_limite_mensal,
        u.ia_custo_limite_mensal,
        u.ia_ativo,
        u.admin_id,
        admin.email,
        u.ativo,
        ia.uso_mes,
        ia.custo_mes
      ORDER BY u.id ASC
    `);

    const resumo = await client.query(`
      SELECT
        COUNT(*) AS total_usuarios,
        COUNT(*) FILTER (
          WHERE COALESCE(ativo, true) = true
        ) AS contas_ativas
      FROM usuarios
    `);

    const totais = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM campanhas) AS total_campanhas,
        (SELECT COUNT(*) FROM leads) AS total_leads
    `);

    return c.json({
      usuarios: result.rows,
      total_usuarios: resumo.rows[0].total_usuarios,
      contas_ativas: resumo.rows[0].contas_ativas,
      total_campanhas: totais.rows[0].total_campanhas,
      total_leads: totais.rows[0].total_leads
    });

  } catch (err) {

    console.error("ERRO ADMIN USUARIOS:", err);

    return c.json({
      error: "Erro ao carregar painel admin"
    }, 500);
  }
});



app.get("/admin/recursos", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    if (user.tipo !== "super_admin") {
      return c.json({ error: "Acesso negado" }, 403);
    }

    const memoria = process.memoryUsage();
    const billing = await client.query(
      `SELECT * FROM railway_billing_config WHERE id = 1 LIMIT 1`
    );
    const billingAtual = billing.rows[0] || null;
    let billingHistorico = await client.query(
      `
      SELECT *
      FROM railway_billing_historico
      ORDER BY ciclo_mes DESC
      LIMIT 12
      `
    );

    if (
      billingAtual &&
      !billingHistorico.rows.length &&
      (
        Number(billingAtual.ultimo_pagamento_valor || 0) > 0 ||
        Number(billingAtual.proxima_fatura_base || 0) > 0
      )
    ) {
      const dataReferencia =
        billingAtual.proxima_fatura_data ||
        billingAtual.ultimo_pagamento_data ||
        new Date().toISOString().slice(0, 10);

      const cicloMes =
        `${String(dataReferencia).slice(0, 7)}-01`;

      await client.query(
        `
        INSERT INTO railway_billing_historico (
          ciclo_mes,
          plano,
          moeda,
          ultimo_pagamento_valor,
          ultimo_pagamento_data,
          proxima_fatura_base,
          proxima_fatura_data,
          observacoes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (ciclo_mes) DO NOTHING
        `,
        [
          cicloMes,
          billingAtual.plano || "pro",
          billingAtual.moeda || "USD",
          Number(billingAtual.ultimo_pagamento_valor || 0),
          billingAtual.ultimo_pagamento_data || null,
          Number(billingAtual.proxima_fatura_base || 20),
          billingAtual.proxima_fatura_data || null,
          billingAtual.observacoes || null
        ]
      );

      billingHistorico = await client.query(
        `
        SELECT *
        FROM railway_billing_historico
        ORDER BY ciclo_mes DESC
        LIMIT 12
        `
      );
    }

    return c.json({
      uptime_segundos: Math.floor(process.uptime()),
      memoria: {
        rss_mb: Math.round(memoria.rss / 1024 / 1024),
        heap_total_mb: Math.round(memoria.heapTotal / 1024 / 1024),
        heap_usado_mb: Math.round(memoria.heapUsed / 1024 / 1024),
        externo_mb: Math.round(memoria.external / 1024 / 1024)
      },
      node_env: process.env.NODE_ENV || "development",
      plataforma: process.platform,
      versao_node: process.version,
      railway_billing: billingAtual,
      railway_billing_historico: billingHistorico.rows
    });

  } catch (err) {

    console.error("ERRO ADMIN RECURSOS:", err);

    return c.json({
      error: "Erro ao buscar recursos"
    }, 500);
  }
});

app.post("/ia/leads/:id/sugestao", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const limite =
      limitarRequisicao(c, `ia:${user.id}`, 30, 60 * 1000);

    if (limite) return limite;

    const bloqueio =
      await motivoBloqueioIA(user);

    if (bloqueio) {
      return c.json({ error: bloqueio }, 403);
    }

    const body =
      await c.req.json().catch(() => ({}));
    const tipo =
      textoOpcional(body.tipo) ||
      "resposta_chat";
    const id =
      c.req.param("id");

    const leadResult = await client.query(
      `
      SELECT
        id,
        nome,
        telefone,
        email,
        status,
        origem,
        campanha,
        observacao,
        score,
        motivo_perda,
        respostas_qualificacao,
        criado_em
      FROM leads
      WHERE id = $1
      AND usuario_id = $2
      LIMIT 1
      `,
      [id, user.id]
    );

    const lead =
      leadResult.rows[0];

    if (!lead) {
      return c.json({ error: "Lead nao encontrado" }, 404);
    }

    const dias =
      idadeLeadEmDias(lead);
    const nome =
      lead.nome || "tudo bem";

    let objetivo =
      "Gerar resposta curta para atendimento comercial do lead.";
    let tipoUso: TipoUsoIA =
      "mensagem_whatsapp";
    let fallback =
      sugestaoIAFallback(
        "Resposta sugerida",
        "Mensagem curta para retomar ou continuar o atendimento.",
        "Enviar mensagem e tentar qualificar necessidade, regiao, valor e prazo.",
        [
          `Oi ${nome}! Vi seu interesse e queria te ajudar com opcoes mais alinhadas. Qual regiao e faixa de valor fazem mais sentido para voce hoje?`
        ],
        [],
        [],
        [
          "Use tom direto e humano.",
          "Evite mensagem longa no primeiro contato."
        ]
      );

    if (tipo === "followup") {
      tipoUso = "followup_lead";
      objetivo =
        "Gerar follow-up inteligente conforme tempo parado do lead: 1 dia, 3 dias, 7 dias, 30 dias ou mais.";
      fallback =
        sugestaoIAFallback(
          "Follow-up inteligente",
          `Lead parado ha ${dias ?? "alguns"} dia(s).`,
          "Retomar com uma pergunta simples e uma oferta de ajuda objetiva.",
          [
            `Oi ${nome}! Passando para saber se ainda faz sentido eu te ajudar com opcoes de imoveis. Quer que eu te envie algumas alternativas atualizadas?`
          ],
          [],
          [
            { chave: "tempo_parado", valor: String(dias ?? "-") }
          ],
          [
            "Se nao responder, tente uma ultima mensagem mais curta depois."
          ]
        );
    }

    if (tipo === "motivo_perda") {
      tipoUso = "motivo_perda";
      objetivo =
        "Classificar o motivo provavel de perda do lead entre preco, demora no atendimento, sem financiamento, regiao errada, curiosidade, concorrente ou sem perfil.";
      fallback =
        sugestaoIAFallback(
          "Motivo provavel de perda",
          "A plataforma encontrou poucos dados para cravar o motivo.",
          "Registrar motivo como sem resposta e tentar uma reativacao curta.",
          [
            `Oi ${nome}! So para eu entender melhor: voce deixou de procurar por preco, regiao, financiamento ou encontrou outra opcao?`
          ],
          [
            lead.motivo_perda || "sem resposta"
          ],
          [
            { chave: "motivo_provavel", valor: lead.motivo_perda || "sem resposta" }
          ],
          [
            "Use esse motivo para filtrar recuperacoes futuras."
          ]
        );
    }

    const usoIA =
      await gerarSugestaoComercialOpenAI(
        objetivo,
        {
          lead,
          dias_parado: dias,
          tipo
        },
        fallback
      );

    await registrarUsoIA(
      Number(user.id),
      tipoUso,
      "lead",
      lead.id,
      usoIA.custo_estimado,
      Number(usoIA.usage?.input_tokens || 0),
      Number(usoIA.usage?.output_tokens || 0)
    );

    return c.json({
      sugestao: usoIA.sugestao
    });
  } catch (err) {
    console.error("ERRO IA SUGESTAO LEAD:", err);
    return c.json({ error: "Erro ao gerar sugestao de IA" }, 500);
  }
});

app.post("/ia/leads/reativacao-lote", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const limite =
      limitarRequisicao(c, `ia:${user.id}`, 20, 60 * 1000);

    if (limite) return limite;

    const bloqueio =
      await motivoBloqueioIA(user);

    if (bloqueio) {
      return c.json({ error: bloqueio }, 403);
    }

    const body =
      await c.req.json().catch(() => ({}));
    const ids =
      Array.isArray(body.ids)
        ? body.ids.slice(0, 10).map((id: any) => Number(id)).filter(Boolean)
        : [];

    if (!ids.length) {
      return c.json({ error: "Selecione leads para reativar" }, 400);
    }

    const leadsResult =
      await client.query(
        `
        SELECT
          id,
          nome,
          telefone,
          status,
          campanha,
          observacao,
          motivo_perda,
          criado_em
        FROM leads
        WHERE usuario_id = $1
        AND id = ANY($2::int[])
        ORDER BY criado_em ASC
        LIMIT 10
        `,
        [user.id, ids]
      );

    const leads =
      leadsResult.rows;

    const fallback =
      sugestaoIAFallback(
        "Reativacao em lote",
        `Campanha criada para ${leads.length} lead(s) perdido(s) ou parados.`,
        "Comece pelos leads com telefone e motivo de perda menos definitivo.",
        leads.map((lead: any) =>
          `${lead.nome || "Lead"}: Oi ${lead.nome || "tudo bem"}! Vi que nosso contato ficou parado, mas talvez ainda faca sentido te ajudar. Quer receber opcoes atualizadas dentro do que voce buscava?`
        ),
        [],
        [],
        [
          "Envie em horarios comerciais.",
          "Nao mande textos identicos para todos se houver contexto diferente."
        ]
      );

    const usoIA =
      await gerarSugestaoComercialOpenAI(
        "Criar uma campanha de reativacao em lote com mensagens diferentes por perfil.",
        { leads },
        fallback
      );

    await registrarUsoIA(
      Number(user.id),
      "reativacao_lote",
      "lead_lote",
      ids.join(","),
      usoIA.custo_estimado,
      Number(usoIA.usage?.input_tokens || 0),
      Number(usoIA.usage?.output_tokens || 0)
    );

    return c.json({ sugestao: usoIA.sugestao });
  } catch (err) {
    console.error("ERRO IA REATIVACAO:", err);
    return c.json({ error: "Erro ao gerar reativacao com IA" }, 500);
  }
});

app.get("/ia/resumo-diario", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const limite =
      limitarRequisicao(c, `ia:${user.id}`, 20, 60 * 1000);

    if (limite) return limite;

    const bloqueio =
      await motivoBloqueioIA(user);

    if (bloqueio) {
      return c.json({ error: bloqueio }, 403);
    }

    const leadsResult =
      await client.query(
        `
        SELECT
          id,
          nome,
          telefone,
          status,
          campanha,
          observacao,
          score,
          motivo_perda,
          criado_em
        FROM leads
        WHERE usuario_id = $1
        ORDER BY criado_em DESC
        LIMIT 80
        `,
        [user.id]
      );

    const leads =
      leadsResult.rows;
    const fallback =
      sugestaoIAFallback(
        "Resumo diario IA Ouro",
        "Priorize leads recentes, quentes e parados ha mais tempo.",
        "Focar nos 5 leads com maior chance de conversa hoje.",
        [],
        [],
        leads.slice(0, 5).map((lead: any) => ({
          chave: lead.nome || `Lead ${lead.id}`,
          valor: `${lead.status || "novo"} - ${lead.score || "sem score"}`
        })),
        [
          "Comece pelos leads novos e quentes.",
          "Depois recupere os perdidos com telefone."
        ]
      );

    const usoIA =
      await gerarSugestaoComercialOpenAI(
        "Gerar resumo diario do corretor com os 5 leads que ele deve focar hoje e o motivo.",
        { leads },
        fallback
      );

    await registrarUsoIA(
      Number(user.id),
      "resumo_diario",
      "usuario",
      user.id,
      usoIA.custo_estimado,
      Number(usoIA.usage?.input_tokens || 0),
      Number(usoIA.usage?.output_tokens || 0)
    );

    return c.json({ sugestao: usoIA.sugestao });
  } catch (err) {
    console.error("ERRO IA RESUMO DIARIO:", err);
    return c.json({ error: "Erro ao gerar resumo diario com IA" }, 500);
  }
});

app.post("/ia/campanhas/criador", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const limite =
      limitarRequisicao(c, `ia:${user.id}`, 20, 60 * 1000);

    if (limite) return limite;

    const bloqueio =
      await motivoBloqueioIA(user);

    if (bloqueio) {
      return c.json({ error: bloqueio }, 403);
    }

    const body =
      await c.req.json().catch(() => ({}));
    const campanha =
      body.campanha || {};
    const contexto =
      textoOpcional(body.contexto) || "";
    const nome =
      textoOpcional(campanha.nome) ||
      "Campanha imobiliaria";

    const contextoExtra =
      contexto
        ? ` Contexto fornecido pelo anunciante: ${contexto}.`
        : "";

    const abordagens = [
      "abordagem direta com urgencia e chamada para acao clara",
      "abordagem emocional e aspiracional focada no sonho da casa propria",
      "abordagem pratica listando beneficios concretos e diferenciais do imovel"
    ];

    const fallback =
      sugestaoIAFallback(
        "Criador de anuncio IA",
        "Sugestao inicial para campanha de captacao de leads.",
        "Preencher os campos do anuncio e revisar antes de publicar.",
        [],
        [],
        [
          { chave: "titulo", valor: nome },
          { chave: "texto", valor: "Encontre o imovel ideal com atendimento rapido e opcoes alinhadas ao seu perfil. Cadastre-se para receber mais informacoes." },
          { chave: "descricao", valor: "Atendimento rapido pelo corretor." },
          { chave: "perguntas", valor: "Qual regiao voce procura?\nQual faixa de investimento?\nPretende financiar?" },
          { chave: "interesses", valor: "imoveis, financiamento imobiliario, apartamento" }
        ],
        [
          "Use imagem real do imovel ou empreendimento.",
          "Mantenha o texto objetivo."
        ]
      );

    const resultados = await Promise.all(
      abordagens.map(abordagem =>
        gerarSugestaoComercialOpenAI(
          `Criar sugestoes para anuncio Meta com ${abordagem}: titulo, texto principal, descricao, perguntas do formulario e interesses.${contextoExtra}`,
          { campanha },
          fallback
        )
      )
    );

    const custoTotal =
      resultados.reduce(
        (sum, r) => sum + (r.custo_estimado || 0),
        0
      );
    const inputTotal =
      resultados.reduce(
        (sum, r) => sum + Number(r.usage?.input_tokens || 0),
        0
      );
    const outputTotal =
      resultados.reduce(
        (sum, r) => sum + Number(r.usage?.output_tokens || 0),
        0
      );

    await registrarUsoIA(
      Number(user.id),
      "criador_campanha",
      "campanha",
      null,
      custoTotal,
      inputTotal,
      outputTotal
    );

    return c.json({
      sugestoes: resultados.map(r => r.sugestao)
    });
  } catch (err) {
    console.error("ERRO IA CRIADOR CAMPANHA:", err);
    return c.json({ error: "Erro ao gerar campanha com IA" }, 500);
  }
});

app.post("/ia/campanhas/analise", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const limite =
      limitarRequisicao(c, `ia:${user.id}`, 20, 60 * 1000);

    if (limite) return limite;

    const bloqueio =
      await motivoBloqueioIA(user);

    if (bloqueio) {
      return c.json({ error: bloqueio }, 403);
    }

    const body =
      await c.req.json().catch(() => ({}));
    const campanha =
      body.campanha || {};

    const fallback =
      sugestaoIAFallback(
        "Analise de campanha IA",
        "Analise baseada em gasto, leads, CPL, CTR e status da campanha.",
        "Acompanhar CPL e ajustar criativo, publico ou orcamento se a campanha estiver cara.",
        [],
        [],
        [],
        [
          "Se gerou leads com CPL aceitavel, mantenha ou aumente aos poucos.",
          "Se teve gasto sem leads, revise publico e criativo.",
          "Se CTR estiver baixo, teste outro texto ou imagem."
        ]
      );

    const usoIA =
      await gerarSugestaoComercialOpenAI(
        "Analisar campanha e recomendar aumentar orcamento, pausar, trocar criativo, mudar publico ou ajustar chamada.",
        { campanha },
        fallback
      );

    await registrarUsoIA(
      Number(user.id),
      "analise_campanha",
      "campanha",
      campanha.id || campanha.campaign_id || null,
      usoIA.custo_estimado,
      Number(usoIA.usage?.input_tokens || 0),
      Number(usoIA.usage?.output_tokens || 0)
    );

    return c.json({ sugestao: usoIA.sugestao });
  } catch (err) {
    console.error("ERRO IA ANALISE CAMPANHA:", err);
    return c.json({ error: "Erro ao analisar campanha com IA" }, 500);
  }
});

app.put("/admin/railway-billing", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");

    if (user.tipo !== "super_admin") {
      return c.json({ error: "Acesso negado" }, 403);
    }

    const body = await c.req.json();
    const dataReferencia =
      body.proxima_fatura_data ||
      body.ultimo_pagamento_data ||
      new Date().toISOString().slice(0, 10);

    const cicloMes =
      `${String(dataReferencia).slice(0, 7)}-01`;

    const result = await client.query(
      `
      UPDATE railway_billing_config
      SET
        plano = COALESCE($1, plano),
        moeda = COALESCE($2, moeda),
        ultimo_pagamento_valor = COALESCE($3, ultimo_pagamento_valor),
        ultimo_pagamento_data = COALESCE($4, ultimo_pagamento_data),
        proxima_fatura_base = COALESCE($5, proxima_fatura_base),
        proxima_fatura_data = COALESCE($6, proxima_fatura_data),
        observacoes = COALESCE($7, observacoes),
        atualizado_em = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [
        body.plano || null,
        body.moeda || null,
        body.ultimo_pagamento_valor === undefined
          ? null
          : Number(body.ultimo_pagamento_valor),
        body.ultimo_pagamento_data || null,
        body.proxima_fatura_base === undefined
          ? null
          : Number(body.proxima_fatura_base),
        body.proxima_fatura_data || null,
        body.observacoes ?? null
      ]
    );

    await client.query(
      `
      INSERT INTO railway_billing_historico (
        ciclo_mes,
        plano,
        moeda,
        ultimo_pagamento_valor,
        ultimo_pagamento_data,
        proxima_fatura_base,
        proxima_fatura_data,
        observacoes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (ciclo_mes)
      DO UPDATE SET
        plano = EXCLUDED.plano,
        moeda = EXCLUDED.moeda,
        ultimo_pagamento_valor = EXCLUDED.ultimo_pagamento_valor,
        ultimo_pagamento_data = EXCLUDED.ultimo_pagamento_data,
        proxima_fatura_base = EXCLUDED.proxima_fatura_base,
        proxima_fatura_data = EXCLUDED.proxima_fatura_data,
        observacoes = EXCLUDED.observacoes,
        atualizado_em = CURRENT_TIMESTAMP
      `,
      [
        cicloMes,
        body.plano || "pro",
        body.moeda || "USD",
        body.ultimo_pagamento_valor === undefined
          ? 0
          : Number(body.ultimo_pagamento_valor),
        body.ultimo_pagamento_data || null,
        body.proxima_fatura_base === undefined
          ? 20
          : Number(body.proxima_fatura_base),
        body.proxima_fatura_data || null,
        body.observacoes ?? null
      ]
    );

    return c.json({
      sucesso: true,
      railway_billing: result.rows[0]
    });

  } catch (err) {
    console.error("ERRO RAILWAY BILLING:", err);
    return c.json({
      error: "Erro ao salvar dados de cobranca Railway"
    }, 500);
  }
});


app.put("/admin/usuarios/:id/status", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    if (user.tipo !== "super_admin") {
      return c.json({ error: "Acesso negado" }, 403);
    }

    const id = c.req.param("id");

    const { ativo } = await c.req.json();

    await client.query(
      `
      UPDATE usuarios
      SET ativo = $1
      WHERE id = $2
      `,
      [ativo, id]
    );

    return c.json({
      sucesso: true
    });

  } catch (err) {

    console.error("ERRO STATUS USUARIO:", err);

    return c.json({
      error: "Erro ao alterar status do usuário"
    }, 500);
  }
});


// 🛡️ ADMIN - CRIAR USUÁRIO
app.put("/admin/usuarios/:id/plano", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    if (user.tipo !== "super_admin") {
      return c.json({ error: "Acesso negado" }, 403);
    }

    const id = c.req.param("id");
    const { plano } = await c.req.json();
    const planoFinal = normalizarPlano(plano);

    const alvo = await client.query(
      `
      SELECT id, tipo
      FROM usuarios
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    if (!alvo.rows.length) {
      return c.json({ error: "Usuário não encontrado" }, 404);
    }

    await client.query(
      `
      UPDATE usuarios
      SET
        plano = $1,
        plano_ativado_em = CASE
          WHEN $1 = 'ouro'
          AND COALESCE(plano, 'bronze') <> 'ouro'
            THEN NOW()
          WHEN $1 <> 'ouro'
            THEN NULL
          ELSE plano_ativado_em
        END,
        assinatura_inicio = CASE
          WHEN $1 = 'ouro'
          AND assinatura_inicio IS NULL
            THEN NOW()
          WHEN $1 <> 'ouro'
            THEN NULL
          ELSE assinatura_inicio
        END,
        assinatura_status = CASE
          WHEN $1 = 'ouro'
            THEN COALESCE(NULLIF(assinatura_status, ''), 'manual')
          ELSE 'manual'
        END
      WHERE id = $2
      `,
      [planoFinal, id]
    );

    return c.json({
      sucesso: true,
      plano: planoFinal,
      acesso_total: false,
      recursos: obterRecursosPlano(
        planoFinal
      )
    });

  } catch (err) {

    console.error("ERRO PLANO USUARIO:", err);

    return c.json({
      error: "Erro ao alterar plano do usuário"
    }, 500);
  }
});

app.post("/admin/usuarios", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    if (
      user.tipo !== "super_admin" &&
      user.tipo !== "master"
    ) {
      return c.json({
        error: "Acesso negado"
      }, 403);
    }

    const {
      nome,
      sobrenome,
      email,
      senha,
      tipo,
      admin_id,
      plano
    } = await c.req.json();

    if (
      !nome ||
      !sobrenome ||
      !email ||
      !senha
    ) {
      return c.json({
        error: "Nome, sobrenome, email e senha são obrigatórios"
      }, 400);
    }

    const senhaForte =
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#._-]).{8,}$/;

    if (!senhaForte.test(senha)) {
      return c.json({
        error: "Senha fraca. Use maiúscula, minúscula, número e símbolo."
      }, 400);
    }

    const existe = await client.query(
      `
      SELECT id
      FROM usuarios
      WHERE email = $1
      `,
      [email]
    );

    if (existe.rows.length > 0) {
      return c.json({
        error: "Email já cadastrado"
      }, 400);
    }

    const senhaHash = await gerarHashSenha(senha);
    const planoFinal = normalizarPlano(plano);

    await client.query(
      `
      INSERT INTO usuarios (
        nome,
        sobrenome,
        email,
        senha,
        tipo,
        ativo,
        admin_id,
        plano,
        plano_ativado_em,
        assinatura_inicio,
        assinatura_status
      )
      VALUES (
        $1,$2,$3,$4,$5,true,$6,$7,
        CASE WHEN $7 = 'ouro' THEN NOW() ELSE NULL END,
        CASE WHEN $7 = 'ouro' THEN NOW() ELSE NULL END,
        CASE WHEN $7 = 'ouro' THEN 'manual' ELSE 'manual' END
      )
      `,
      [
        nome,
        sobrenome,
        email,
        senhaHash,
        tipo || "corretor",
        admin_id || null,
        planoFinal
      ]
    );

    return c.json({
      sucesso: true
    });

  } catch (err) {

    console.error("ERRO CRIAR USUARIO:", err);

    return c.json({
      error: "Erro ao criar usuário"
    }, 500);
  }
});

// 🛡️ ADMIN - TROCAR SENHA
app.put("/admin/usuarios/:id/senha", authMiddleware, async (c) => {

  const user: any = c.get("user");

  if (user.tipo !== "super_admin") {
    return c.json({ error: "Acesso negado" }, 403);
  }

  const id = c.req.param("id");

  const { senha } = await c.req.json();

  if (!senha) {
    return c.json({ error: "Senha obrigatória" }, 400);
  }

  const senhaHash = await gerarHashSenha(senha);

  await client.query(
    `
    UPDATE usuarios
    SET senha = $1
    WHERE id = $2
    `,
    [senhaHash, id]
  );

  return c.json({ sucesso: true });
});


// 🛡️ ADMIN - ALTERAR TIPO
app.put("/admin/usuarios/:id/tipo", authMiddleware, async (c) => {

  const user: any = c.get("user");

  if (user.tipo !== "super_admin") {
    return c.json({ error: "Acesso negado" }, 403);
  }

  const id = c.req.param("id");

  const { tipo } = await c.req.json();

  await client.query(
    `
    UPDATE usuarios
    SET tipo = $1
    WHERE id = $2
    `,
    [tipo, id]
  );

  return c.json({ sucesso: true });
});

app.delete("/admin/usuarios/:id", authMiddleware, async (c) => {

  try {
    const user: any = c.get("user");
    const id = Number(c.req.param("id"));

    if (user.tipo !== "super_admin") {
      return c.json({ error: "Acesso negado" }, 403);
    }

    if (id === Number(user.id)) {
      return c.json({
        error: "Você não pode excluir seu próprio usuário."
      }, 400);
    }

    const alvo = await client.query(
      "SELECT id, tipo FROM usuarios WHERE id = $1",
      [id]
    );

    if (alvo.rows.length === 0) {
      return c.json({ error: "Usuário não encontrado" }, 404);
    }

    if (alvo.rows[0].tipo === "super_admin") {
      return c.json({
        error: "Não é permitido excluir usuário Super Admin."
      }, 400);
    }

    await client.query(
      "DELETE FROM usuarios WHERE id = $1",
      [id]
    );

    return c.json({ sucesso: true });

  } catch (err) {
    console.error("ERRO EXCLUIR USUARIO:", err);

    return c.json({
      error: "Erro ao excluir usuário"
    }, 500);
  }
});




// 🔐 ALTERAR SENHA
app.post("/admin/trocar-senha", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    const body = await c.req.json();

    const {
      usuario_id,
      nova_senha
    } = body;

    if (!SENHA_FORTE.test(nova_senha)) {

      return c.json({
        error:
          "Senha fraca. Use maiúscula, minúscula, número e símbolo (@$!%*?&#._-)."
      }, 400);
    }

    // 🔥 busca usuário alvo
    const alvo = await client.query(
      `
      SELECT *
      FROM usuarios
      WHERE id = $1
      `,
      [usuario_id]
    );

    if (alvo.rows.length === 0) {

      return c.json({
        error: "Usuário não encontrado"
      }, 404);
    }

    const usuarioAlvo = alvo.rows[0];

    // 🔐 permissões
    const permitido =
      user.tipo === "super_admin" ||
      Number(user.id) === Number(usuario_id) ||
      (
        user.tipo === "admin_corretor" &&
        Number(usuarioAlvo.admin_id) === Number(user.id)
      );

    if (!permitido) {

      return c.json({
        error: "Acesso negado"
      }, 403);
    }

    const novaSenhaHash = await gerarHashSenha(nova_senha);

    await client.query(
      `
      UPDATE usuarios
      SET senha = $1
      WHERE id = $2
      `,
      [
        novaSenhaHash,
        usuario_id
      ]
    );

    return c.json({
      success: true
    });

  } catch (err) {

    console.error(
      "ERRO TROCAR SENHA:",
      err
    );

    return c.json({
      error: "Erro ao trocar senha"
    }, 500);
  }
});



// 🔄 AUTO SYNC A CADA 5 MIN
//setInterval(() => {

//  sincronizarTodasCampanhas();

//}, 1000 * 60 * 5);


/* =========================
   📝 FEEDBACK
========================= */

app.post("/feedback", authMiddleware, async (c: any) => {
  const user: any = c.get("user");
  const { tipo, mensagem } = await c.req.json();

  if (!mensagem?.trim()) {
    return c.json({ error: "Mensagem vazia" }, 400);
  }

  if (!Bun.env.RESEND_API_KEY) {
    return c.json({ error: "Serviço de email não configurado" }, 500);
  }

  const tiposValidos: Record<string, string> = {
    elogio: "⭐ Elogio",
    sugestao: "💡 Sugestão",
    reclamacao: "⚠️ Reclamação"
  };

  const tipoLabel = tiposValidos[tipo] || "📩 Mensagem";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${Bun.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: "pereira.notlim@gmail.com",
      subject: `${tipoLabel} — Plataforma de Leads`,
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;max-width:560px;">
          <h2 style="margin-bottom:4px;">${tipoLabel}</h2>
          <p style="color:#6b7280;font-size:13px;margin-top:0;">Plataforma de Leads</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
          <p><strong>De:</strong> ${user.email}</p>
          <p><strong>Tipo:</strong> ${tipoLabel}</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
          <p style="white-space:pre-wrap;">${mensagem.trim().replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
        </div>
      `
    })
  });

  if (!res.ok) {
    return c.json({ error: "Erro ao enviar feedback" }, 500);
  }

  return c.json({ sucesso: true });
});

/* =========================
   💬 CHAT DE SUPORTE
========================= */

function isSuporte(tipo: string) {
  return tipo === "suporte" || tipo === "super_admin";
}

// Usuário envia mensagem (cria conversa se não existir)
async function obterOuCriarConversaUsuario(usuarioId: number) {
  const aberta = await client.query(
    `SELECT id
     FROM chat_conversas
     WHERE usuario_id = $1
     AND status = 'aberta'
     ORDER BY id DESC
     LIMIT 1`,
    [usuarioId]
  );

  if (aberta.rows.length > 0) {
    return aberta.rows[0].id;
  }

  const fechada = await client.query(
    `SELECT id
     FROM chat_conversas
     WHERE usuario_id = $1
     ORDER BY atualizado_em DESC
     LIMIT 1`,
    [usuarioId]
  );

  if (fechada.rows.length > 0) {
    await client.query(
      `UPDATE chat_conversas
       SET status = 'aberta',
           atualizado_em = NOW()
       WHERE id = $1`,
      [fechada.rows[0].id]
    );

    return fechada.rows[0].id;
  }

  const nova = await client.query(
    `INSERT INTO chat_conversas (usuario_id)
     VALUES ($1)
     RETURNING id`,
    [usuarioId]
  );

  return nova.rows[0].id;
}

async function enviarMensagemSuporteParaUsuario(
  suporteId: number,
  usuarioId: number,
  conteudo: string
) {
  const conversaId =
    await obterOuCriarConversaUsuario(usuarioId);

  await client.query(
    `INSERT INTO chat_mensagens (conversa_id, remetente_id, remetente_tipo, conteudo)
     VALUES ($1, $2, 'suporte', $3)`,
    [conversaId, suporteId, conteudo.trim()]
  );

  await client.query(
    `UPDATE chat_conversas
     SET status = 'aberta',
         atualizado_em = NOW()
     WHERE id = $1`,
    [conversaId]
  );

  return conversaId;
}

app.get("/chat/usuarios", authMiddleware, async (c: any) => {
  const user: any = c.get("user");

  if (!isSuporte(user.tipo)) {
    return c.json({ error: "Acesso negado" }, 403);
  }

  const result = await client.query(
    `SELECT id, email, nome, sobrenome, tipo, COALESCE(ativo, true) AS ativo
     FROM usuarios
     WHERE COALESCE(ativo, true) = true
     AND tipo NOT IN ('suporte', 'super_admin', 'master')
     ORDER BY nome NULLS LAST, email ASC`
  );

  return c.json({ usuarios: result.rows });
});

app.post("/chat/mensagem", authMiddleware, async (c: any) => {
  const user: any = c.get("user");
  const { conteudo } = await c.req.json();

  if (!conteudo?.trim()) {
    return c.json({ error: "Mensagem vazia" }, 400);
  }

  const conversa = await client.query(
    `SELECT id FROM chat_conversas WHERE usuario_id = $1 AND status = 'aberta' ORDER BY id DESC LIMIT 1`,
    [user.id]
  );

  let conversaId: number;

  if (conversa.rows.length === 0) {
    const nova = await client.query(
      `INSERT INTO chat_conversas (usuario_id) VALUES ($1) RETURNING id`,
      [user.id]
    );
    conversaId = nova.rows[0].id;
  } else {
    conversaId = conversa.rows[0].id;
  }

  await client.query(
    `INSERT INTO chat_mensagens (conversa_id, remetente_id, remetente_tipo, conteudo)
     VALUES ($1, $2, 'usuario', $3)`,
    [conversaId, user.id, conteudo.trim()]
  );

  await client.query(
    `UPDATE chat_conversas SET atualizado_em = NOW() WHERE id = $1`,
    [conversaId]
  );

  return c.json({ sucesso: true, conversa_id: conversaId });
});

// Usuário busca mensagens da sua conversa
app.get("/chat/mensagens", authMiddleware, async (c: any) => {
  const user: any = c.get("user");

  const conversa = await client.query(
    `SELECT id FROM chat_conversas WHERE usuario_id = $1 AND status = 'aberta' ORDER BY id DESC LIMIT 1`,
    [user.id]
  );

  if (conversa.rows.length === 0) {
    return c.json({ mensagens: [], conversa_id: null });
  }

  const conversaId = conversa.rows[0].id;

  // Marcar mensagens do suporte como lidas
  await client.query(
    `UPDATE chat_mensagens SET lido = TRUE
     WHERE conversa_id = $1 AND remetente_tipo = 'suporte' AND lido = FALSE`,
    [conversaId]
  );

  const msgs = await client.query(
    `SELECT id, remetente_tipo, conteudo, lido, enviado_em
     FROM chat_mensagens WHERE conversa_id = $1 ORDER BY enviado_em ASC`,
    [conversaId]
  );

  return c.json({ mensagens: msgs.rows, conversa_id: conversaId });
});

// Contagem de mensagens não lidas do suporte (para badge)
app.get("/chat/nao-lidas", authMiddleware, async (c: any) => {
  const user: any = c.get("user");

  const result = await client.query(
    `SELECT COUNT(*) AS total
     FROM chat_mensagens m
     JOIN chat_conversas cv ON cv.id = m.conversa_id
     WHERE cv.usuario_id = $1
       AND m.remetente_tipo = 'suporte'
       AND m.lido = FALSE`,
    [user.id]
  );

  return c.json({ nao_lidas: Number(result.rows[0].total) });
});

// Suporte: lista todas as conversas abertas
app.get("/chat/conversas", authMiddleware, async (c: any) => {
  const user: any = c.get("user");

  if (!isSuporte(user.tipo)) {
    return c.json({ error: "Acesso negado" }, 403);
  }

  const result = await client.query(
    `SELECT cv.id, cv.status, cv.criado_em, cv.atualizado_em,
            u.email AS usuario_email, u.nome AS usuario_nome,
            (SELECT COUNT(*) FROM chat_mensagens m
             WHERE m.conversa_id = cv.id
               AND m.remetente_tipo = 'usuario'
               AND m.lido = FALSE) AS nao_lidas
     FROM chat_conversas cv
     JOIN usuarios u ON u.id = cv.usuario_id
     ORDER BY cv.atualizado_em DESC`
  );

  return c.json({ conversas: result.rows });
});

// Suporte: mensagens de uma conversa específica
app.get("/chat/conversas/:id/mensagens", authMiddleware, async (c: any) => {
  const user: any = c.get("user");

  if (!isSuporte(user.tipo)) {
    return c.json({ error: "Acesso negado" }, 403);
  }

  const id = Number(c.req.param("id"));

  // Marcar mensagens do usuário como lidas
  await client.query(
    `UPDATE chat_mensagens SET lido = TRUE
     WHERE conversa_id = $1 AND remetente_tipo = 'usuario' AND lido = FALSE`,
    [id]
  );

  const msgs = await client.query(
    `SELECT m.id, m.remetente_tipo, m.conteudo, m.lido, m.enviado_em,
            u.email AS remetente_email, u.nome AS remetente_nome
     FROM chat_mensagens m
     LEFT JOIN usuarios u ON u.id = m.remetente_id
     WHERE m.conversa_id = $1
     ORDER BY m.enviado_em ASC`,
    [id]
  );

  const conv = await client.query(
    `SELECT cv.id, cv.status, u.email AS usuario_email, u.nome AS usuario_nome
     FROM chat_conversas cv JOIN usuarios u ON u.id = cv.usuario_id WHERE cv.id = $1`,
    [id]
  );

  return c.json({ mensagens: msgs.rows, conversa: conv.rows[0] || null });
});

// Suporte: responde em uma conversa
app.post("/chat/conversas/:id/responder", authMiddleware, async (c: any) => {
  const user: any = c.get("user");

  if (!isSuporte(user.tipo)) {
    return c.json({ error: "Acesso negado" }, 403);
  }

  const id = Number(c.req.param("id"));
  const { conteudo } = await c.req.json();

  if (!conteudo?.trim()) {
    return c.json({ error: "Mensagem vazia" }, 400);
  }

  const conversa = await client.query(
    `SELECT status
     FROM chat_conversas
     WHERE id = $1
     LIMIT 1`,
    [id]
  );

  if (!conversa.rows.length) {
    return c.json({ error: "Conversa nao encontrada" }, 404);
  }

  if (conversa.rows[0].status === "fechada") {
    return c.json({
      error: "Reabra a conversa antes de responder"
    }, 409);
  }

  await client.query(
    `INSERT INTO chat_mensagens (conversa_id, remetente_id, remetente_tipo, conteudo)
     VALUES ($1, $2, 'suporte', $3)`,
    [id, user.id, conteudo.trim()]
  );

  await client.query(
    `UPDATE chat_conversas SET atualizado_em = NOW() WHERE id = $1`,
    [id]
  );

  return c.json({ sucesso: true });
});

app.post("/chat/usuarios/:id/mensagem", authMiddleware, async (c: any) => {
  const user: any = c.get("user");

  if (!isSuporte(user.tipo)) {
    return c.json({ error: "Acesso negado" }, 403);
  }

  const usuarioId = Number(c.req.param("id"));
  const { conteudo } = await c.req.json();

  if (!conteudo?.trim()) {
    return c.json({ error: "Mensagem vazia" }, 400);
  }

  const alvo = await client.query(
    `SELECT id
     FROM usuarios
     WHERE id = $1
     AND COALESCE(ativo, true) = true
     AND tipo NOT IN ('suporte', 'super_admin', 'master')
     LIMIT 1`,
    [usuarioId]
  );

  if (!alvo.rows.length) {
    return c.json({ error: "Usuario nao encontrado" }, 404);
  }

  const conversaId =
    await enviarMensagemSuporteParaUsuario(
      user.id,
      usuarioId,
      conteudo
    );

  return c.json({
    sucesso: true,
    conversa_id: conversaId
  });
});

app.post("/chat/broadcast", authMiddleware, async (c: any) => {
  const user: any = c.get("user");

  if (!isSuporte(user.tipo)) {
    return c.json({ error: "Acesso negado" }, 403);
  }

  const { conteudo } = await c.req.json();

  if (!conteudo?.trim()) {
    return c.json({ error: "Mensagem vazia" }, 400);
  }

  const usuarios = await client.query(
    `SELECT id
     FROM usuarios
     WHERE COALESCE(ativo, true) = true
     AND tipo NOT IN ('suporte', 'super_admin', 'master')`
  );

  for (const usuario of usuarios.rows) {
    await enviarMensagemSuporteParaUsuario(
      user.id,
      usuario.id,
      conteudo
    );
  }

  return c.json({
    sucesso: true,
    total: usuarios.rows.length
  });
});

// Suporte: fecha uma conversa
app.put("/chat/conversas/:id/fechar", authMiddleware, async (c: any) => {
  const user: any = c.get("user");

  if (!isSuporte(user.tipo)) {
    return c.json({ error: "Acesso negado" }, 403);
  }

  const id = Number(c.req.param("id"));

  await client.query(
    `UPDATE chat_conversas SET status = 'fechada' WHERE id = $1`,
    [id]
  );

  return c.json({ sucesso: true });
});

app.put("/chat/conversas/:id/reabrir", authMiddleware, async (c: any) => {
  const user: any = c.get("user");

  if (!isSuporte(user.tipo)) {
    return c.json({ error: "Acesso negado" }, 403);
  }

  const id = Number(c.req.param("id"));

  await client.query(
    `UPDATE chat_conversas
     SET status = 'aberta',
         atualizado_em = NOW()
     WHERE id = $1`,
    [id]
  );

  return c.json({ sucesso: true });
});

/* =========================
   🔍 HEALTH
========================= */

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.get("/api/version", (c) => c.json({
  version: "delete-user-route-v1",
  delete_user_route: true
}));

// Corrige criado_em dos leads Meta usando created_time real da API
app.post("/admin/corrigir-datas-leads", authMiddleware, masterMiddleware, async (c: any) => {
  try {
    const leadsRes = await client.query(`
      SELECT l.id, l.lead_id, l.usuario_id, l.criado_em
      FROM leads l
      WHERE l.origem = 'meta'
        AND l.lead_id IS NOT NULL
      ORDER BY l.id DESC
    `);

    const leads = leadsRes.rows;
    let atualizados = 0;
    let erros = 0;
    const detalhes: any[] = [];

    for (const lead of leads) {
      try {
        const tokenRes = await client.query(`
          SELECT access_token FROM meta_conexoes
          WHERE usuario_id = $1
          ORDER BY id DESC LIMIT 1
        `, [lead.usuario_id]);

        if (tokenRes.rows.length === 0) continue;

        const token = tokenRes.rows[0].access_token;
        const resp = await fetch(
          `https://graph.facebook.com/v19.0/${lead.lead_id}?fields=created_time&access_token=${token}`
        );
        const data: any = await resp.json();

        if (!data.created_time) {
          erros++;
          detalhes.push({ lead_id: lead.lead_id, erro: "sem created_time" });
          continue;
        }

        const novaData = new Date(data.created_time).toISOString();
        await client.query(
          `UPDATE leads SET criado_em = $1 WHERE id = $2`,
          [novaData, lead.id]
        );
        atualizados++;
        detalhes.push({ lead_id: lead.lead_id, de: lead.criado_em, para: novaData });
      } catch (err: any) {
        erros++;
        detalhes.push({ lead_id: lead.lead_id, erro: err.message });
      }
    }

    return c.json({ total: leads.length, atualizados, erros, detalhes });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

/* =========================
   🚀 START
========================= */

Bun.serve({
  port: Number(Bun.env.PORT) || 3000,
  fetch: app.fetch,
});





