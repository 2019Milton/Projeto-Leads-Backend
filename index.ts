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

const PLATAFORMA_CONTATO_EMAIL =
  Bun.env.PLATAFORMA_CONTATO_EMAIL ||
  "contato@plataformadeleads.com.br";

const PLATAFORMA_FROM_EMAIL =
  Bun.env.PLATAFORMA_FROM_EMAIL ||
  `Plataforma de Leads <${PLATAFORMA_CONTATO_EMAIL}>`;

const FEEDBACK_DESTINO_EMAIL =
  Bun.env.FEEDBACK_DESTINO_EMAIL ||
  Bun.env.SUPPORT_EMAIL ||
  PLATAFORMA_CONTATO_EMAIL;

const SENHA_FORTE =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#._-]).{8,}$/;

const PLANOS_PLATAFORMA = [
  "bronze",
  "prata",
  "ouro"
] as const;

// 🤝 percentual repassado ao parceiro sobre o valor cobrado do cliente
const PARCEIRO_PERCENTUAL_COMISSAO = 0.35;

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

function escaparHtmlEmail(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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

const ESTRATEGIAS_BID_COM_VALOR = new Set([
  "LOWEST_COST_WITH_BID_CAP",
  "COST_CAP",
  "TARGET_COST"
]);

function normalizarBidStrategyMeta(value: unknown) {
  const strategy = textoOpcional(value).toUpperCase();

  if (!strategy || strategy === "AUTOMATICO" || strategy === "AUTO") {
    return "LOWEST_COST_WITHOUT_CAP";
  }

  return strategy;
}

function bidStrategyExigeValor(value: unknown) {
  return ESTRATEGIAS_BID_COM_VALOR.has(
    normalizarBidStrategyMeta(value)
  );
}

function prepararControleCustoMeta(
  strategyValue: unknown,
  amountValue: unknown
) {
  const bidStrategy =
    normalizarBidStrategyMeta(strategyValue);
  const bidAmount =
    numeroOpcional(amountValue);

  if (!bidStrategyExigeValor(bidStrategy)) {
    return {
      bidStrategy: null,
      bidAmount: null
    };
  }

  if (bidAmount !== null && bidAmount > 0) {
    return {
      bidStrategy,
      bidAmount
    };
  }

  return {
    bidStrategy: null,
    bidAmount: null
  };
}

function erroMetaBidAmount(resposta: any) {
  const mensagem = String(
    resposta?.error?.error_user_msg ||
    resposta?.error?.message ||
    resposta?.error ||
    ""
  ).toLowerCase();

  return (
    mensagem.includes("bid_amount") ||
    mensagem.includes("valor do lance") ||
    mensagem.includes("lance obrigatório") ||
    mensagem.includes("lowest_cost_with_bid_cap") ||
    mensagem.includes("target_cost")
  );
}

function erroMetaIdade(resposta: any) {
  const mensagem = String(
    resposta?.error?.error_user_msg ||
    resposta?.error?.message ||
    resposta?.error ||
    ""
  ).toLowerCase();

  return (
    mensagem.includes("age_min") ||
    mensagem.includes("age_max") ||
    mensagem.includes("minimum age") ||
    mensagem.includes("idade") ||
    (
      mensagem.includes("age") &&
      mensagem.includes("targeting")
    )
  );
}

async function enviarPayloadMetaComFallbackBid(
  url: string,
  payload: Record<string, any>,
  contexto = "META"
) {
  const enviar = async (body: Record<string, any>) =>
    fetch(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    ).then(r => r.json());

  let resposta = await enviar(payload);

  if (erroMetaBidAmount(resposta)) {
    const retryPayload = { ...payload };
    delete retryPayload.bid_strategy;
    delete retryPayload.bid_amount;

    console.warn(
      `${contexto}: Meta rejeitou controle de lance, tentando novamente sem bid_strategy/bid_amount`,
      resposta?.error || resposta
    );

    resposta = await enviar(retryPayload);
  }

  if (erroMetaIdade(resposta) && payload.targeting) {
    const retryPayload = {
      ...payload,
      targeting: {
        ...payload.targeting
      }
    };

    delete retryPayload.targeting.age_min;
    delete retryPayload.targeting.age_max;
    delete retryPayload.targeting.genders;

    console.warn(
      `${contexto}: Meta rejeitou idade/genero do publico, tentando novamente com publico amplo`,
      resposta?.error || resposta
    );

    resposta = await enviar(retryPayload);
  }

  return resposta;
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

  console.log("META /me/accounts resposta:", JSON.stringify({ total: pages.data?.length ?? 0, error: pages.error ?? null }));

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

// 🔥 Detecta a conta profissional do Instagram vinculada (via Página ou via Business Manager)
async function detectarInstagramMeta(
  token: string,
  paginas: any[]
) {
  let instagram =
    paginas.find((pagina: any) =>
      pagina.instagram?.id
    )?.instagram || null;

  const primeiraPagina = paginas[0];

  if (!instagram && primeiraPagina?.id) {

    const instaRes = await fetch(
      `https://graph.facebook.com/v19.0/${primeiraPagina.id}?fields=instagram_business_account&access_token=${token}`
    ).then(r => r.json());

    if (instaRes.instagram_business_account?.id) {

      const instaInfo = await fetch(
        `https://graph.facebook.com/v19.0/${instaRes.instagram_business_account.id}?fields=username,profile_picture_url&access_token=${token}`
      ).then(r => r.json());

      instagram = {
        id: instaRes.instagram_business_account.id,
        username: instaInfo.username || null,
        profile_picture_url: instaInfo.profile_picture_url || null
      };

      // Reflete o vinculo encontrado na propria Pagina, para o front-end
      primeiraPagina.instagram = instagram;
    }
  }

  // Conta vinculada direto ao portfólio do Business Manager (sem Página)
  if (!instagram) {
    try {
      const businesses = await fetch(
        `https://graph.facebook.com/v19.0/me/businesses?fields=id,name&access_token=${token}`
      ).then(r => r.json());

      console.log("META BUSINESSES:", JSON.stringify(businesses));

      for (const business of businesses.data || []) {

        const igAccounts = await fetch(
          `https://graph.facebook.com/v19.0/${business.id}/instagram_accounts?fields=id,username,profile_picture_url&access_token=${token}`
        ).then(r => r.json());

        console.log(
          `META INSTAGRAM ACCOUNTS (business ${business.id}):`,
          JSON.stringify(igAccounts)
        );

        if (igAccounts.data?.length) {
          instagram = igAccounts.data[0];
          break;
        }
      }
    } catch (e) {
      console.error("ERRO INSTAGRAM BUSINESS:", e);
    }

    // Reflete o vinculo encontrado via Business Manager nas Paginas, para o front-end
    if (instagram) {
      for (const pagina of paginas) {
        pagina.instagram = instagram;
      }
    }
  }

  return instagram;
}

// 🔥 Contas do Instagram vinculadas ao Gerenciador de Negócios da conta de anúncios
// (utilizáveis como instagram_actor_id mesmo sem vínculo direto com a Página)
async function listarContasInstagramAnuncio(
  token: string,
  adAccountId: string
) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/instagram_accounts?fields=id,username,profile_picture_url&access_token=${token}`
    ).then(r => r.json());

    console.log(
      "META INSTAGRAM ACCOUNTS (ad account):",
      JSON.stringify({ total: res.data?.length ?? 0, error: res.error ?? null })
    );

    return Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    console.error("ERRO INSTAGRAM ACCOUNTS AD ACCOUNT:", e);
    return [];
  }
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

function mensagemErroMeta(resposta: any, fallback: string) {
  return (
    resposta?.error?.error_user_msg ||
    resposta?.error?.message ||
    resposta?.detalhe?.error_user_msg ||
    resposta?.detalhe?.message ||
    resposta?.message ||
    resposta?.error ||
    fallback
  );
}

async function registrarErroPublicacaoCampanha(
  campanhaId: number,
  mensagem: string
) {
  await client.query(
    `
    UPDATE campanhas
    SET
      configuracoes_avancadas =
        COALESCE(configuracoes_avancadas, '{}'::jsonb) ||
        jsonb_build_object(
          'ultimo_erro_publicacao', $1::text,
          'ultimo_erro_publicacao_em', NOW()
        ),
      atualizado_em = NOW()
    WHERE id = $2
    `,
    [mensagem, campanhaId]
  );
}

async function limparErroPublicacaoCampanha(campanhaId: number) {
  await client.query(
    `
    UPDATE campanhas
    SET
      configuracoes_avancadas =
        COALESCE(configuracoes_avancadas, '{}'::jsonb) -
        'ultimo_erro_publicacao' -
        'ultimo_erro_publicacao_em',
      atualizado_em = NOW()
    WHERE id = $1
    `,
    [campanhaId]
  );
}

async function enviarImagemMetaPorUrl(
  token: string,
  adAccountId: string,
  urlImagem: string
) {
  const body = new URLSearchParams();
  body.set("url", urlImagem);
  body.set("access_token", token);

  const upload = await fetch(
    `https://graph.facebook.com/v19.0/${adAccountId}/adimages`,
    {
      method: "POST",
      body
    }
  ).then(r => r.json());

  const primeiraImagem =
    upload?.images &&
    (Object.values(upload.images || {})?.[0] as any);

  return {
    hash: primeiraImagem?.hash || null,
    resposta: upload
  };
}

function montarTargetingMeta(avancadas: any) {
  const pais =
    textoOpcional(avancadas?.pais)
      .toUpperCase()
      .slice(0, 2) || "BR";

  const localidades =
    Array.isArray(avancadas?.localidades)
      ? avancadas.localidades
      : [];

  const targeting: any = {
    geo_locations: {
      countries: [pais],
      location_types: [
        "home",
        "recent"
      ]
    }
  };

  const camposGeoPorTipo: Record<string, string> = {
    country: "countries",
    region: "regions",
    city: "cities",
    neighborhood: "neighborhoods",
    zip: "zips",
    geo_market: "geo_markets",
    electoral_district: "electoral_districts"
  };

  const gruposGeo: Record<string, any[]> = {};

  for (const local of localidades) {
    const key = textoOpcional(local?.key);
    const tipo = textoOpcional(local?.tipo);
    const campo = camposGeoPorTipo[tipo];

    if (!key || !campo) continue;

    if (campo === "countries") {
      gruposGeo.countries = gruposGeo.countries || [];
      gruposGeo.countries.push(key);
      continue;
    }

    const entrada: any = { key };

    if (campo === "cities" || campo === "zips") {
      const raio = numeroOpcional(local?.raio);

      if (raio !== null) {
        entrada.radius = raio;
        entrada.distance_unit = "kilometer";
      }
    }

    gruposGeo[campo] = gruposGeo[campo] || [];
    gruposGeo[campo].push(entrada);
  }

  if (Object.keys(gruposGeo).length) {
    targeting.geo_locations = {
      ...gruposGeo,
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

  // Meta exige age_min e age_max; usa 18/65 como default quando não informado
  targeting.age_min = idadeMin !== null ? Math.max(18, Math.min(65, idadeMin)) : 18;
  targeting.age_max = idadeMax !== null ? Math.max(18, Math.min(65, idadeMax)) : 65;

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

  const FACEBOOK_POSITIONS_DEPRECATED = ["video_feeds"];
  const facebookPositions =
    listaOpcional(avancadas?.facebook_positions)
      .filter((p: string) => !FACEBOOK_POSITIONS_DEPRECATED.includes(p));

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

  const advantageAudienceDesativado =
    avancadas?.advantage_audience === false ||
    avancadas?.advantage_audience === 0 ||
    avancadas?.advantage_audience === "0" ||
    avancadas?.advantage_audience === "false";

  targeting.targeting_automation = {
    advantage_audience: advantageAudienceDesativado ? 0 : 1
  };

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
  const primeiroNomeSeguro =
    escaparHtmlEmail(primeiroNome);
  const resetUrlSeguro =
    escaparHtmlEmail(resetUrl);
  const siteUrl =
    obterFrontendUrl();
  const siteUrlSeguro =
    escaparHtmlEmail(siteUrl);
  const contatoEmailSeguro =
    escaparHtmlEmail(PLATAFORMA_CONTATO_EMAIL);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${Bun.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: PLATAFORMA_FROM_EMAIL,
      to: email,
      reply_to: PLATAFORMA_CONTATO_EMAIL,
      subject: "Redefinicao de senha - Plataforma de Leads",
      text: [
        "Plataforma de Leads",
        "Gestao Inteligente de Clientes",
        "",
        `Ola, ${primeiroNome}.`,
        "",
        "Recebemos uma solicitacao para redefinir a senha da sua conta na Plataforma de Leads.",
        `Para criar uma nova senha, acesse: ${resetUrl}`,
        "",
        `Esse link expira em ${RESET_PASSWORD_TTL_MINUTES} minutos e so pode ser usado uma vez.`,
        "Se voce nao solicitou essa alteracao, ignore este email. Sua senha atual continuara valida.",
        "",
        `Site oficial: ${siteUrl}`,
        `Contato: ${PLATAFORMA_CONTATO_EMAIL}`
      ].join("\n"),
      html: `
        <div style="margin:0;padding:0;background:#f6f8fb;font-family:Arial,sans-serif;color:#111827;">
          <div style="max-width:620px;margin:0 auto;padding:28px 16px;">
            <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
              <div style="background:#050816;padding:22px 26px;color:#ffffff;">
                <h1 style="font-size:22px;line-height:1.3;margin:0;">Plataforma de Leads</h1>
                <p style="margin:6px 0 0;color:#9ca3af;font-size:13px;letter-spacing:.04em;text-transform:uppercase;">Gestao Inteligente de Clientes</p>
              </div>

              <div style="padding:28px 26px;line-height:1.6;">
                <h2 style="font-size:20px;margin:0 0 14px;color:#111827;">Redefinicao de senha</h2>
                <p style="margin:0 0 14px;">Ola, ${primeiroNomeSeguro}.</p>
                <p style="margin:0 0 18px;">Recebemos uma solicitacao para redefinir a senha da sua conta na Plataforma de Leads.</p>

                <p style="margin:24px 0;">
                  <a href="${resetUrlSeguro}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:13px 20px;border-radius:8px;text-decoration:none;font-weight:bold;">
                    Criar nova senha
                  </a>
                </p>

                <p style="margin:0 0 14px;color:#374151;">Esse link expira em <strong>${RESET_PASSWORD_TTL_MINUTES} minutos</strong> e so pode ser usado uma vez.</p>

                <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:20px 0;">
                  <p style="margin:0 0 8px;font-weight:bold;color:#111827;">Nao foi voce?</p>
                  <p style="margin:0;color:#4b5563;">Se voce nao solicitou essa alteracao, ignore este email. Sua senha atual continuara valida.</p>
                </div>

                <p style="margin:0 0 8px;color:#6b7280;font-size:13px;">Se o botao nao funcionar, copie e cole este link no navegador:</p>
                <p style="margin:0 0 20px;word-break:break-all;font-size:13px;">
                  <a href="${resetUrlSeguro}" style="color:#2563eb;">${resetUrlSeguro}</a>
                </p>

                <hr style="border:none;border-top:1px solid #e5e7eb;margin:22px 0;">
                <p style="margin:0;color:#6b7280;font-size:13px;">Site oficial: <a href="${siteUrlSeguro}" style="color:#2563eb;">${siteUrlSeguro}</a></p>
                <p style="margin:4px 0 0;color:#6b7280;font-size:13px;">Contato: <a href="mailto:${contatoEmailSeguro}" style="color:#2563eb;">${contatoEmailSeguro}</a></p>
              </div>
            </div>
          </div>
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

  if (lead.status === "primeiro_contato") {
    pontos += 15;
    base.push("+15 Atendimento iniciado");
  }

  if (lead.status === "em_conversa") {
    pontos += 30;
    base.push("+30 Lead em conversa");
  }

  if (lead.status === "fechado") {
    pontos += 60;
    base.push("+60 Lead fechado");
  }

  if (lead.status === "perdido") {
    pontos -= 40;
    base.push("-40 Lead marcado como perdido");
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

function contextoNicho(lead: any) {
  const slug = String(lead?.nicho_slug || "").toLowerCase();
  const nome = String(lead?.nicho_nome || "").toLowerCase();

  const isImoveis    = slug.includes("imovel") || slug.includes("imóvel") || nome.includes("imóv") || nome.includes("imovel");
  const isSaude      = slug.includes("saude")  || slug.includes("saúde")  || nome.includes("saúde") || nome.includes("saude");
  const isSuplemento = slug.includes("suplement") || nome.includes("suplement");
  const isSaas       = slug.includes("saas") || slug.includes("plataforma") || nome.includes("saas") || nome.includes("plataforma");
  const isEducacao   = slug.includes("educa") || nome.includes("educa") || nome.includes("curso") || nome.includes("ensino");
  const isAuto       = slug.includes("auto") || nome.includes("auto") || nome.includes("veículo") || nome.includes("veiculo") || nome.includes("carro");
  const isConsorcio  = slug.includes("consorcio") || slug.includes("consórcio") || nome.includes("consórcio") || nome.includes("consorcio");

  if (isImoveis) return {
    nicho: "Imóveis",
    produto: "imóvel",
    produto_pl: "imóveis",
    verbo_interesse: "comprar ou alugar",
    qualificadores: ["faixa de valor", "região preferida", "prazo para decisão", "financiamento ou entrada própria"],
    perguntas: [
      "Você pretende comprar, alugar ou apenas pesquisar por enquanto?",
      "Qual faixa de valor ou parcela mensal fica confortável?",
      "Tem uma região preferida ou bairros que deseja evitar?",
      "Pretende usar financiamento, entrada própria ou outro formato?",
      "Qual prazo ideal para visitar ou decidir?"
    ],
    msg_quente: (nome: string) => `Oi ${nome}! Vi seu interesse e queria te ajudar a avançar. Qual melhor horário para falarmos hoje sobre o imóvel e uma possível visita?`,
    msg_morno:  (nome: string) => `Oi ${nome}! Recebi seu interesse e queria entender melhor o que você procura. Qual região, faixa de valor e prazo ideal para você?`,
    msg_frio:   (nome: string) => `Oi ${nome}! Passando para confirmar se ainda faz sentido eu te enviar algumas opções de imóveis dentro do que você procura.`,
    msg_rec_alta: (nome: string) => `Oi ${nome}! Vi que nosso contato ficou parado, mas talvez ainda faça sentido te ajudar. Quer que eu te envie opções atualizadas de imóveis?`,
    msg_rec_media: (nome: string) => `Oi ${nome}! Passando para confirmar se ainda existe interesse. Se fizer sentido, posso retomar com imóveis mais alinhados para você.`,
    msg_rec_baixa: (nome: string) => `Oi ${nome}! Só confirmando: ainda faz sentido mantermos seu contato para futuras oportunidades de imóveis?`,
    system: "Você é uma IA comercial especializada em imóveis. Analise o lead, priorize a ação do corretor e, quando o status for perdido, foque em recuperação. Use linguagem focada em visitas, financiamento, região e perfil do imóvel."
  };

  if (isSaude) return {
    nicho: "Planos de Saúde",
    produto: "plano de saúde",
    produto_pl: "planos de saúde",
    verbo_interesse: "contratar um plano",
    qualificadores: ["quantidade de vidas/dependentes", "faixa etária", "valor máximo de mensalidade", "cobertura necessária", "região/cidade"],
    perguntas: [
      "Quantas pessoas serão cobertas pelo plano (titular + dependentes)?",
      "Qual a faixa etária do titular e dos dependentes?",
      "Tem preferência por alguma operadora ou tipo de cobertura?",
      "Qual o valor mensal máximo que fica confortável?",
      "Precisa de cobertura para alguma especialidade ou procedimento específico?"
    ],
    msg_quente: (nome: string) => `Oi ${nome}! Vi que você tem interesse em um plano de saúde. Posso te apresentar as melhores opções para o seu perfil hoje?`,
    msg_morno:  (nome: string) => `Oi ${nome}! Para te indicar o melhor plano de saúde, me ajuda com uma info: qual a quantidade de pessoas e faixa etária que precisam de cobertura?`,
    msg_frio:   (nome: string) => `Oi ${nome}! Você ainda tem interesse em contratar um plano de saúde? Posso te enviar opções atualizadas sem compromisso.`,
    msg_rec_alta: (nome: string) => `Oi ${nome}! Vi que você demonstrou interesse em plano de saúde. Tenho novas opções que podem se encaixar melhor no seu orçamento. Posso te mostrar?`,
    msg_rec_media: (nome: string) => `Oi ${nome}! Passando para saber se ainda tem interesse em plano de saúde. Se quiser, posso retomar com opções mais alinhadas ao seu perfil.`,
    msg_rec_baixa: (nome: string) => `Oi ${nome}! Só confirmando: ainda faz sentido mantermos seu contato para oportunidades em planos de saúde?`,
    system: "Você é uma IA comercial especializada em planos de saúde. Analise o lead, priorize a ação do vendedor e, quando o status for perdido, foque em recuperação. Use linguagem focada em número de vidas, faixa etária, cobertura e mensalidade."
  };

  if (isSuplemento) return {
    nicho: "Suplementos",
    produto: "suplemento",
    produto_pl: "suplementos",
    verbo_interesse: "comprar suplementos",
    qualificadores: ["objetivo (ganho de massa, emagrecimento, etc.)", "suplementos de interesse", "frequência de treino", "orçamento"],
    perguntas: [
      "Qual seu objetivo principal? (ganho de massa, emagrecimento, desempenho...)",
      "Já usa algum suplemento atualmente?",
      "Com que frequência você treina por semana?",
      "Tem alguma restrição alimentar ou alergia?",
      "Qual orçamento mensal você tem disponível para suplementação?"
    ],
    msg_quente: (nome: string) => `Oi ${nome}! Vi seu interesse nos nossos suplementos. Qual é o seu objetivo principal — ganho de massa, emagrecimento ou desempenho? Assim consigo te indicar o melhor!`,
    msg_morno:  (nome: string) => `Oi ${nome}! Para te ajudar a escolher o suplemento certo, me conta: qual seu objetivo e com que frequência você treina?`,
    msg_frio:   (nome: string) => `Oi ${nome}! Você ainda tem interesse em suplementação? Posso te enviar algumas opções de acordo com o seu objetivo.`,
    msg_rec_alta: (nome: string) => `Oi ${nome}! Temos novidades e promoções nos suplementos que você pode gostar. Qual era seu objetivo mesmo? Posso te mandar opções atualizadas!`,
    msg_rec_media: (nome: string) => `Oi ${nome}! Passando para saber se ainda tem interesse em suplementação. Se quiser, posso te enviar opções sem compromisso.`,
    msg_rec_baixa: (nome: string) => `Oi ${nome}! Só confirmando: ainda faz sentido mantermos seu contato para oportunidades em suplementos?`,
    system: "Você é uma IA comercial especializada em suplementos esportivos e nutrição. Analise o lead, priorize a ação do vendedor e, quando o status for perdido, foque em recuperação. Use linguagem focada em objetivo do cliente, frequência de treino e produto ideal."
  };

  if (isSaas) return {
    nicho: "Plataforma / SaaS",
    produto: "plataforma",
    produto_pl: "plataformas",
    verbo_interesse: "usar a plataforma",
    qualificadores: ["tamanho da equipe/empresa", "caso de uso principal", "ferramentas atuais", "orçamento", "prazo para decisão"],
    perguntas: [
      "Qual é o principal problema ou processo que você quer resolver com a plataforma?",
      "Quantas pessoas na sua equipe usariam a ferramenta?",
      "Atualmente você usa alguma outra ferramenta para isso?",
      "Qual o prazo ideal para começar a usar?",
      "Já tem orçamento aprovado para contratar uma solução?"
    ],
    msg_quente: (nome: string) => `Oi ${nome}! Vi que você tem interesse na plataforma. Posso fazer uma demonstração rápida hoje para você ver como podemos ajudar no seu processo?`,
    msg_morno:  (nome: string) => `Oi ${nome}! Para entender como a plataforma pode te ajudar, me conta: qual é o principal desafio que você quer resolver com uma ferramenta como a nossa?`,
    msg_frio:   (nome: string) => `Oi ${nome}! Você ainda tem interesse na plataforma? Posso te enviar um material explicando como ela funciona na prática.`,
    msg_rec_alta: (nome: string) => `Oi ${nome}! Vi que você demonstrou interesse na nossa plataforma. Temos melhorias novas que podem se encaixar bem no que você precisava. Que tal uma demo rápida?`,
    msg_rec_media: (nome: string) => `Oi ${nome}! Passando para saber se ainda faz sentido conhecer a plataforma. Posso retomar com informações mais alinhadas ao seu caso de uso.`,
    msg_rec_baixa: (nome: string) => `Oi ${nome}! Só confirmando: ainda faz sentido mantermos seu contato para oportunidades na plataforma?`,
    system: "Você é uma IA comercial especializada em plataformas SaaS e software. Analise o lead, priorize a ação do vendedor e, quando o status for perdido, foque em recuperação. Use linguagem focada em caso de uso, tamanho de equipe, ferramentas atuais e ROI da solução."
  };

  if (isEducacao) return {
    nicho: "Educação",
    produto: "curso",
    produto_pl: "cursos",
    verbo_interesse: "se matricular",
    qualificadores: ["área de interesse", "nível de experiência", "disponibilidade de horário", "formato (online/presencial)", "orçamento"],
    perguntas: [
      "Qual área ou habilidade você quer desenvolver?",
      "Já tem alguma experiência no tema?",
      "Prefere aulas ao vivo, gravadas ou presenciais?",
      "Qual horário tem disponível para estudar?",
      "Tem orçamento aprovado para investir no curso?"
    ],
    msg_quente: (nome: string) => `Oi ${nome}! Vi seu interesse no curso. Qual é o seu objetivo principal com essa formação? Assim consigo te indicar a melhor turma!`,
    msg_morno:  (nome: string) => `Oi ${nome}! Para te ajudar a escolher o curso certo, me conta: qual área quer desenvolver e qual horário tem disponível?`,
    msg_frio:   (nome: string) => `Oi ${nome}! Você ainda tem interesse em se qualificar nessa área? Posso te enviar detalhes do curso sem compromisso.`,
    msg_rec_alta: (nome: string) => `Oi ${nome}! Temos novas turmas com horários que podem se encaixar melhor para você. Ainda tem interesse em se qualificar?`,
    msg_rec_media: (nome: string) => `Oi ${nome}! Passando para saber se ainda tem interesse no curso. Se quiser, posso retomar com as opções atualizadas.`,
    msg_rec_baixa: (nome: string) => `Oi ${nome}! Só confirmando: ainda faz sentido mantermos seu contato para futuras oportunidades de cursos?`,
    system: "Você é uma IA comercial especializada em educação e cursos. Analise o lead, priorize a ação do vendedor e, quando o status for perdido, foque em recuperação. Use linguagem focada em objetivo de aprendizagem, disponibilidade de horário e formato do curso."
  };

  if (isAuto) return {
    nicho: "Automóveis",
    produto: "veículo",
    produto_pl: "veículos",
    verbo_interesse: "comprar um veículo",
    qualificadores: ["tipo de veículo", "faixa de preço", "novo ou seminovo", "forma de pagamento", "prazo"],
    perguntas: [
      "Você prefere veículo novo ou seminovo?",
      "Qual faixa de preço ou prestação mensal fica confortável?",
      "Tem algum modelo ou marca de preferência?",
      "Pretende dar algum veículo como entrada?",
      "Qual prazo ideal para fechar negócio?"
    ],
    msg_quente: (nome: string) => `Oi ${nome}! Vi seu interesse em um veículo. Qual modelo você tem em mente? Posso verificar a disponibilidade e te apresentar as melhores condições hoje!`,
    msg_morno:  (nome: string) => `Oi ${nome}! Para te ajudar a encontrar o veículo certo, me conta: você prefere novo ou seminovo e qual faixa de valor fica confortável?`,
    msg_frio:   (nome: string) => `Oi ${nome}! Você ainda tem interesse em adquirir um veículo? Posso te enviar algumas opções dentro do que você procura.`,
    msg_rec_alta: (nome: string) => `Oi ${nome}! Temos novos veículos com condições especiais. Ainda tem interesse? Posso te apresentar opções atualizadas!`,
    msg_rec_media: (nome: string) => `Oi ${nome}! Passando para saber se ainda tem interesse em um veículo. Posso retomar com opções mais alinhadas ao que você busca.`,
    msg_rec_baixa: (nome: string) => `Oi ${nome}! Só confirmando: ainda faz sentido mantermos seu contato para futuras oportunidades de veículos?`,
    system: "Você é uma IA comercial especializada em automóveis e veículos. Analise o lead, priorize a ação do vendedor e, quando o status for perdido, foque em recuperação. Use linguagem focada em modelo, ano, forma de pagamento e necessidade do cliente."
  };

  if (isConsorcio) return {
    nicho: "Consórcio",
    produto: "consórcio",
    produto_pl: "consórcios",
    verbo_interesse: "contratar um consórcio",
    qualificadores: ["bem desejado (imóvel, veículo...)", "valor da carta", "prazo do grupo", "parcela máxima"],
    perguntas: [
      "Qual bem você quer adquirir com o consórcio? (imóvel, carro, moto...)",
      "Qual o valor da carta de crédito que você precisa?",
      "Qual parcela mensal fica dentro do seu orçamento?",
      "Tem preferência por um prazo específico do grupo?",
      "Você já participou de algum consórcio antes?"
    ],
    msg_quente: (nome: string) => `Oi ${nome}! Vi seu interesse em consórcio. Qual bem você quer conquistar? Assim consigo te apresentar as melhores condições disponíveis!`,
    msg_morno:  (nome: string) => `Oi ${nome}! Para te indicar o melhor consórcio, me conta: qual o bem desejado e o valor de carta que você precisa?`,
    msg_frio:   (nome: string) => `Oi ${nome}! Você ainda tem interesse em consórcio? Posso te enviar simulações sem compromisso.`,
    msg_rec_alta: (nome: string) => `Oi ${nome}! Vi que você tinha interesse em consórcio. Temos grupos com condições especiais que podem te atender bem. Posso te mostrar?`,
    msg_rec_media: (nome: string) => `Oi ${nome}! Passando para saber se ainda tem interesse em consórcio. Posso retomar com simulações atualizadas para você.`,
    msg_rec_baixa: (nome: string) => `Oi ${nome}! Só confirmando: ainda faz sentido mantermos seu contato para oportunidades em consórcio?`,
    system: "Você é uma IA comercial especializada em consórcio. Analise o lead, priorize a ação do vendedor e, quando o status for perdido, foque em recuperação. Use linguagem focada no bem desejado, valor da carta, prazo do grupo e parcela."
  };

  // Genérico — sem nicho identificado
  const nichoNome = lead?.nicho_nome || "produto/serviço";
  return {
    nicho: nichoNome,
    produto: nichoNome,
    produto_pl: nichoNome,
    verbo_interesse: "contratar",
    qualificadores: ["perfil do cliente", "orçamento", "prazo", "necessidade específica"],
    perguntas: [
      "O que te motivou a entrar em contato?",
      "Qual é a sua principal necessidade no momento?",
      "Qual orçamento você tem disponível?",
      "Qual o prazo ideal para você tomar uma decisão?",
      "Tem alguma dúvida específica que posso esclarecer agora?"
    ],
    msg_quente: (nome: string) => `Oi ${nome}! Vi seu interesse e queria te ajudar a avançar. Qual melhor horário para conversarmos hoje?`,
    msg_morno:  (nome: string) => `Oi ${nome}! Recebi seu interesse e queria entender melhor o que você procura. Pode me contar um pouco mais sobre sua necessidade?`,
    msg_frio:   (nome: string) => `Oi ${nome}! Passando para confirmar se ainda faz sentido eu te enviar mais informações sobre o que você estava buscando.`,
    msg_rec_alta: (nome: string) => `Oi ${nome}! Vi que nosso contato ficou parado. Ainda posso te ajudar? Me conta o que você precisava e retomamos de onde paramos.`,
    msg_rec_media: (nome: string) => `Oi ${nome}! Passando para confirmar se ainda existe interesse. Se fizer sentido, posso retomar com opções mais alinhadas para você.`,
    msg_rec_baixa: (nome: string) => `Oi ${nome}! Só confirmando: ainda faz sentido mantermos seu contato para futuras oportunidades?`,
    system: `Você é uma IA comercial especializada em ${nichoNome}. Analise o lead, priorize a ação do vendedor e, quando o status for perdido, foque em recuperação. Use linguagem clara, objetiva e focada nas necessidades do cliente.`
  };
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
  const ctx = contextoNicho(lead);
  const nomeDisplay = lead?.nome || "tudo bem";

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
      ? `Chamar no WhatsApp hoje e tentar avançar a conversa sobre ${ctx.produto}.`
      : prioridade === "media"
      ? `Enviar mensagem curta para qualificar: ${ctx.qualificadores.slice(0, 2).join(" e ")}.`
      : `Nutrir com abordagem leve antes de insistir em proposta de ${ctx.produto}.`;

  const mensagemWhatsapp =
    prioridade === "alta"
      ? ctx.msg_quente(nomeDisplay)
      : prioridade === "media"
      ? ctx.msg_morno(nomeDisplay)
      : ctx.msg_frio(nomeDisplay);

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
      ? `Reabrir a conversa hoje com mensagem curta e personalizada sobre ${ctx.produto}.`
      : chanceRecuperacao === "media"
      ? `Fazer tentativa leve de retomada e validar se ainda há interesse em ${ctx.produto}.`
      : "Manter no histórico ou arquivar depois de revisar o motivo da perda.";

  const mensagemWhatsappFinal =
    !leadPerdido
      ? mensagemWhatsapp
      : chanceRecuperacao === "alta"
      ? ctx.msg_rec_alta(nomeDisplay)
      : chanceRecuperacao === "media"
      ? ctx.msg_rec_media(nomeDisplay)
      : ctx.msg_rec_baixa(nomeDisplay);

  return {
    disponivel: true,
    nivel: "ouro",
    titulo: "IA Ouro",
    prioridade,
    resumo:
      leadPerdido && chanceRecuperacao === "alta"
        ? `Lead perdido com boa chance de recuperação em ${ctx.nicho}; vale retomar com abordagem curta.`
        : leadPerdido && chanceRecuperacao === "media"
        ? `Lead perdido com chance moderada em ${ctx.nicho}; valide o interesse antes de insistir.`
        : leadPerdido
        ? `Lead perdido com baixa chance em ${ctx.nicho}; mantenha o histórico organizado.`
        : prioridade === "alta"
        ? `Lead com bons sinais comerciais em ${ctx.nicho}; recomendado contato rápido.`
        : prioridade === "media"
        ? `Lead com potencial em ${ctx.nicho}, mas ainda precisa de qualificação antes da abordagem forte.`
        : `Lead com baixa prioridade em ${ctx.nicho} no momento; melhor nutrir ou validar interesse.`,
    proxima_acao: proximaAcaoFinal,
    mensagem_whatsapp: mensagemWhatsappFinal,
    perguntas_qualificacao: ctx.perguntas,
    sinais: sinais.length ? sinais : ["dados ainda limitados para uma análise profunda"],
    riscos,
    explicacao:
      `A IA Ouro cruza a classificação Frio/Morno/Quente, sinais do cadastro, respostas do formulário e previsão do ML (quando disponível) com foco no nicho ${ctx.nicho}. Ela entrega resumo, prioridade, próxima ação e mensagem pronta para reduzir tempo de atendimento.`,
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

function calcularCustoEstimadoAnthropic(usage: { input_tokens: number; output_tokens: number }) {
  // claude-haiku-4-5-20251001: $0.25/1M input, $1.25/1M output
  const inputBRL = Number(Bun.env.ANTHROPIC_INPUT_1M_BRL || 1.44);
  const outputBRL = Number(Bun.env.ANTHROPIC_OUTPUT_1M_BRL || 7.19);
  return Number(
    ((usage.input_tokens / 1_000_000) * inputBRL +
     (usage.output_tokens / 1_000_000) * outputBRL).toFixed(4)
  );
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
  const fallback = gerarAnaliseIAOuroLead(lead, ml);

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
    nicho_nome: lead?.nicho_nome || null,
    nicho_slug: lead?.nicho_slug || null,
    criado_em: lead?.criado_em || null,
    ml
  };

  const ctx = contextoNicho(lead);
  const iaConf = await buscarConfigIA();
  const systemMsg =
    `${ctx.system} Responda somente no JSON solicitado, em portugues do Brasil, com texto curto, pratico e pronto para uso. IMPORTANTE: as mensagens de WhatsApp devem ser naturais, personalizadas ao nicho "${ctx.nicho}" e sem emojis ou caracteres especiais. As perguntas de qualificacao devem focar em: ${ctx.qualificadores.join(", ")}.`;
  const schemaDescricao =
    `Retorne SOMENTE JSON valido com esta estrutura exata (sem texto antes ou depois):
{"prioridade":"alta"|"media"|"baixa","resumo":"string","proxima_acao":"string","mensagem_whatsapp":"string","perguntas_qualificacao":["string"],"sinais":["string"],"riscos":["string"],"explicacao":"string","recuperacao":{"chance":"alta"|"media"|"baixa"|"nao_aplicavel","motivo_perda":"string","recomendacao":"string"}}`;
  const userText = JSON.stringify({
    lead: payloadLead,
    nicho: ctx.nicho,
    produto: ctx.produto,
    objetivo: `Gerar analise comercial focada em ${ctx.nicho}, proxima acao, mensagem de WhatsApp personalizada para o nicho e recuperacao quando aplicavel.`
  });

  const parseAnalise = (texto: string) => {
    const limpo = texto.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    return normalizarAnaliseOpenAI(JSON.parse(limpo), fallback);
  };

  // ── Tenta OpenAI ──────────────────────────────────────────────
  const openaiKey = Bun.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const modelo =
        textoOpcional(iaConf?.modelo) ||
        textoOpcional(Bun.env.OPENAI_MODEL) ||
        "gpt-5-mini";
      const usarResponsesAPI =
        modelo.startsWith("gpt-5") || modelo.startsWith("o1") ||
        modelo.startsWith("o3") || modelo.startsWith("o4");

      const respBody = usarResponsesAPI
        ? {
            model: modelo,
            instructions: systemMsg,
            input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
            text: {
              format: {
                type: "json_schema",
                name: "analise_ia_lead",
                strict: true,
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["prioridade","resumo","proxima_acao","mensagem_whatsapp","perguntas_qualificacao","sinais","riscos","explicacao","recuperacao"],
                  properties: {
                    prioridade: { type: "string", enum: ["alta","media","baixa"] },
                    resumo: { type: "string" },
                    proxima_acao: { type: "string" },
                    mensagem_whatsapp: { type: "string" },
                    perguntas_qualificacao: { type: "array", items: { type: "string" } },
                    sinais: { type: "array", items: { type: "string" } },
                    riscos: { type: "array", items: { type: "string" } },
                    explicacao: { type: "string" },
                    recuperacao: {
                      type: "object",
                      additionalProperties: false,
                      required: ["chance","motivo_perda","recomendacao"],
                      properties: {
                        chance: { type: "string", enum: ["alta","media","baixa","nao_aplicavel"] },
                        motivo_perda: { type: "string" },
                        recomendacao: { type: "string" }
                      }
                    }
                  }
                }
              }
            },
            max_output_tokens: 1200
          }
        : {
            model: modelo,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemMsg + "\n\n" + schemaDescricao },
              { role: "user", content: userText }
            ],
            max_tokens: 1200
          };

      const response = await fetch(
        usarResponsesAPI ? OPENAI_RESPONSES_URL : "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(respBody)
        }
      );
      const data: any = await response.json();

      if (response.ok) {
        const texto = usarResponsesAPI
          ? extrairTextoRespostaOpenAI(data)
          : (data?.choices?.[0]?.message?.content || "");
        if (texto) {
          return {
            analise: parseAnalise(texto),
            usage: data?.usage || {},
            custo_estimado: calcularCustoEstimadoOpenAI(data?.usage),
            modelo,
            provider: "openai"
          };
        }
      } else {
        console.error("ANALISE OPENAI ERROR:", data?.error?.message, "| model:", modelo);
      }
    } catch (err) {
      console.error("ANALISE OPENAI EXCEPTION:", err);
    }
  }

  // ── Fallback: Anthropic ───────────────────────────────────────
  const anthropicKey = Bun.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      const anthropicModelo =
        textoOpcional(iaConf?.anthropic_modelo) || "claude-haiku-4-5-20251001";
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: anthropicModelo,
          max_tokens: 1200,
          system: systemMsg + "\n\n" + schemaDescricao,
          messages: [{ role: "user", content: userText }]
        })
      });
      const data: any = await resp.json();

      if (resp.ok) {
        const texto = data?.content?.[0]?.text || "";
        if (texto) {
          const inTok = Number(data?.usage?.input_tokens || 0);
          const outTok = Number(data?.usage?.output_tokens || 0);
          return {
            analise: parseAnalise(texto),
            usage: { input_tokens: inTok, output_tokens: outTok },
            custo_estimado: calcularCustoEstimadoAnthropic({ input_tokens: inTok, output_tokens: outTok }),
            modelo: anthropicModelo,
            provider: "anthropic"
          };
        }
      } else {
        console.error("ANALISE ANTHROPIC ERROR:", data?.error?.message);
      }
    } catch (err) {
      console.error("ANALISE ANTHROPIC EXCEPTION:", err);
    }
  }

  return null;
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
  tokensSaida = 0,
  provider = "openai"
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
      custo_estimado,
      provider
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      usuarioId,
      tipo,
      referenciaTipo,
      referenciaId ? String(referenciaId) : null,
      tokensEntrada,
      tokensSaida,
      custoEstimado,
      provider
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

  // Verifica limites globais (somados de todos os usuarios no mes)
  const limReq = Number(configIA?.limite_mensal_requisicoes || 0);
  const limCusto = Number(configIA?.limite_mensal_custo || 0);
  if (limReq > 0 || limCusto > 0) {
    const usoGlobal = await client.query(`
      SELECT COUNT(*) AS chamadas, COALESCE(SUM(custo_estimado), 0) AS custo
      FROM ia_usos
      WHERE criado_em >= date_trunc('month', CURRENT_DATE)
    `);
    const chamadasGlobal = Number(usoGlobal.rows[0]?.chamadas || 0);
    const custoGlobal = Number(usoGlobal.rows[0]?.custo || 0);
    if (limReq > 0 && chamadasGlobal >= limReq) {
      return "Limite mensal global de chamadas atingido.";
    }
    if (limCusto > 0 && custoGlobal >= limCusto) {
      return "Limite mensal global de custo atingido.";
    }
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
  fallback: any,
  providerPreferido: string = "auto"
) {
  const iaConf = await buscarConfigIA();
  const iaProvider =
    ["auto", "openai", "anthropic"].includes(providerPreferido)
      ? providerPreferido
      : "auto";
  const systemMsg =
    "Voce e uma IA comercial senior para corretores imobiliarios. Use somente os dados reais recebidos. Nao invente nomes, telefones, campanhas, motivos ou numeros. Se algum dado estiver ausente, diga que nao ha informacao suficiente. Gere respostas curtas, naturais, praticas e prontas para uso. Responda somente no JSON solicitado, em portugues do Brasil.";
  const schemaDescricao =
    `Retorne SOMENTE JSON valido com esta estrutura exata (sem texto antes ou depois):
{"titulo":"string","resumo":"string","acao_principal":"string","mensagens":["string"],"motivos":["string"],"campos":[{"chave":"string","valor":"string"}],"recomendacoes":["string"]}`;
  const userText = JSON.stringify({ objetivo, dados });

  const parseSugestao = (texto: string, provider: string) => {
    const limpo = texto.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    return {
      ...fallback,
      ...JSON.parse(limpo),
      disponivel: true,
      origem: provider
    };
  };

  // ── Tenta OpenAI ──────────────────────────────────────────────
  const openaiKey = Bun.env.OPENAI_API_KEY;
  if (openaiKey && (iaProvider === "auto" || iaProvider === "openai")) {
    try {
      const modelo =
        textoOpcional(iaConf?.modelo) ||
        textoOpcional(Bun.env.OPENAI_MODEL) ||
        "gpt-5-mini";
      const usarResponsesAPI =
        modelo.startsWith("gpt-5") || modelo.startsWith("o1") ||
        modelo.startsWith("o3") || modelo.startsWith("o4");

      const respBody = usarResponsesAPI
        ? {
            model: modelo,
            instructions: systemMsg,
            input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
            text: {
              format: {
                type: "json_schema",
                name: "sugestao_comercial_ia",
                strict: true,
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["titulo","resumo","acao_principal","mensagens","motivos","campos","recomendacoes"],
                  properties: {
                    titulo: { type: "string" },
                    resumo: { type: "string" },
                    acao_principal: { type: "string" },
                    mensagens: { type: "array", items: { type: "string" } },
                    motivos: { type: "array", items: { type: "string" } },
                    campos: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["chave","valor"],
                        properties: { chave: { type: "string" }, valor: { type: "string" } }
                      }
                    },
                    recomendacoes: { type: "array", items: { type: "string" } }
                  }
                }
              }
            }
          }
        : {
            model: modelo,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemMsg + "\n\n" + schemaDescricao },
              { role: "user", content: userText }
            ]
          };

      const response = await fetch(
        usarResponsesAPI ? OPENAI_RESPONSES_URL : "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(respBody)
        }
      );
      const data: any = await response.json();

      if (response.ok) {
        const texto = usarResponsesAPI
          ? extrairTextoRespostaOpenAI(data)
          : (data?.choices?.[0]?.message?.content || "");
        if (texto) {
          return {
            sugestao: parseSugestao(texto, "openai"),
            usage: data?.usage || null,
            custo_estimado: calcularCustoEstimadoOpenAI(data?.usage),
            provider: "openai"
          };
        }
      } else {
        console.error("SUGESTAO OPENAI ERROR:", data?.error?.message, "| model:", modelo);
      }
    } catch (err) {
      console.error("SUGESTAO OPENAI EXCEPTION:", err);
    }
  }

  // ── Fallback: Anthropic ───────────────────────────────────────
  const anthropicKey = Bun.env.ANTHROPIC_API_KEY;
  if (anthropicKey && (iaProvider === "auto" || iaProvider === "anthropic")) {
    try {
      const anthropicModelo =
        textoOpcional(iaConf?.anthropic_modelo) || "claude-haiku-4-5-20251001";
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: anthropicModelo,
          max_tokens: 1200,
          system: systemMsg + "\n\n" + schemaDescricao,
          messages: [{ role: "user", content: userText }]
        })
      });
      const data: any = await resp.json();

      if (resp.ok) {
        const texto = data?.content?.[0]?.text || "";
        if (texto) {
          const inTok = Number(data?.usage?.input_tokens || 0);
          const outTok = Number(data?.usage?.output_tokens || 0);
          return {
            sugestao: parseSugestao(texto, "anthropic"),
            usage: { input_tokens: inTok, output_tokens: outTok },
            custo_estimado: calcularCustoEstimadoAnthropic({ input_tokens: inTok, output_tokens: outTok }),
            provider: "anthropic"
          };
        }
      } else {
        console.error("SUGESTAO ANTHROPIC ERROR:", data?.error?.message);
      }
    } catch (err) {
      console.error("SUGESTAO ANTHROPIC EXCEPTION:", err);
    }
  }

  // Sem IA disponível
  return {
    sugestao: {
      ...fallback,
      disponivel: false,
      origem: "fallback"
    },
    usage: null,
    custo_estimado: 0,
    provider: "fallback"
  };
}


app.use("/*", cors({
  origin: resolverOrigemCors,

  allowMethods: [
    "GET",
    "POST",
    "PUT",
    "PATCH",
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
        u.id,
        u.email,
        u.tipo,
        u.nome,
        u.sobrenome,
        u.plano,
        u.admin_id,
        u.ia_limite_mensal,
        u.ia_custo_limite_mensal,
        u.whatsapp,
        COALESCE(u.notif_whatsapp_lead, true) AS notif_whatsapp_lead,
        COALESCE(u.ia_ativo, true) AS ia_ativo,
        COALESCE(u.ia_provider, 'auto') AS ia_provider,
        COALESCE(u.ativo, true) AS ativo,
        COALESCE(u.is_parceiro, false) AS is_parceiro,
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'id',   n.id,
              'slug', n.slug,
              'nome', n.nome,
              'cor',  n.cor
            ) ORDER BY n.id)
            FROM usuario_nichos un
            INNER JOIN nichos n ON n.id = un.nicho_id
            WHERE un.usuario_id = u.id
          ),
          '[]'::json
        ) AS nichos
      FROM usuarios u
      WHERE u.id = $1
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

// Traduz o effective_status do anúncio para o rótulo da coluna "Veiculação" do Gerenciador de Anúncios
function traduzirVeiculacaoMeta(status?: string | null) {
  const labels: Record<string, string> = {
    ACTIVE: "Ativo",
    PAUSED: "Pausado",
    DELETED: "Excluído",
    PENDING_REVIEW: "Em análise",
    DISAPPROVED: "Reprovado",
    PREAPPROVED: "Pré-aprovado",
    PENDING_BILLING_INFO: "Pendente: dados de pagamento",
    CAMPAIGN_PAUSED: "Campanha pausada",
    ARCHIVED: "Arquivado",
    ADSET_PAUSED: "Conjunto pausado",
    IN_PROCESS: "Preparando",
    WITH_ISSUES: "Com problemas"
  };

  if (!status) return null;

  return labels[status] || status;
}

// Monta a URL de ação específica na Meta com base na subcategoria do problema.
function urlAcaoVeiculacaoMeta(
  subcategoria: string | null,
  campaignId: string | null,
  contaAnunciosId: string | null
): string {
  const actId =
    String(contaAnunciosId || "").replace(/^act_/, "");
  const actParam =
    actId ? `act=${encodeURIComponent(actId)}` : "";
  const campParam =
    campaignId ? `selected_campaign_ids=${encodeURIComponent(campaignId)}` : "";

  const base = "https://adsmanager.facebook.com/adsmanager/manage";

  switch (subcategoria) {
    case "pagamento":
      return `${base}/billing${actParam ? `?${actParam}` : ""}`;
    case "adset_pausado":
      return [
        `${base}/adsets`,
        [actParam, campParam].filter(Boolean).join("&")
      ].filter(Boolean).join("?");
    case "reprovado":
    case "politica":
      return [
        `${base}/ads`,
        [actParam, campParam].filter(Boolean).join("&")
      ].filter(Boolean).join("?");
    default:
      return [
        `${base}/campaigns`,
        [actParam, campParam].filter(Boolean).join("&")
      ].filter(Boolean).join("?");
  }
}

// Resume o status de veiculação da Meta em motivo, ação prática, passos e subcategoria.
function diagnosticarVeiculacaoMeta(
  status: string | null,
  issues: any[] = [],
  erroPagamentoConta?: string | null,
  campanhaStatusLocal?: string | null
) {
  const statusNormalizado =
    String(status || "").toUpperCase();

  const issuePrincipal = issues[0] || null;
  const errorType =
    String(issuePrincipal?.error_type || "").toUpperCase();
  const issueTexto =
    issuePrincipal?.error_summary ||
    issuePrincipal?.error_message ||
    issuePrincipal?.message ||
    null;

  const detalhes =
    issues
      .map((issue: any) =>
        issue.error_summary ||
        issue.error_message ||
        issue.message ||
        ""
      )
      .filter(Boolean)
      .slice(0, 5);

  const isBilling =
    errorType === "BILLING" ||
    /pagamento|payment|billing|cobran/i.test(
      `${issueTexto || ""} ${erroPagamentoConta || ""}`
    );

  const isPolitica =
    errorType === "POLICY" ||
    /política|policy|violat|reprov|disapprov/i.test(issueTexto || "");

  if (!statusNormalizado) {
    return {
      tipo: "desconhecido",
      subcategoria: null as string | null,
      motivo: "A Meta não retornou status de veiculação para os anúncios desta campanha.",
      acao: "Sincronize novamente ou confira a campanha no Gerenciador de Anúncios.",
      acao_passos: [
        "Clique em 'Sincronizar' na campanha",
        "Se o problema persistir, abra o Gerenciador de Anúncios da Meta"
      ],
      detalhes
    };
  }

  if (statusNormalizado === "ACTIVE") {
    return {
      tipo: "ok",
      subcategoria: null as string | null,
      motivo: "A Meta indica que os anúncios estão aptos a veicular.",
      acao: "Acompanhe gasto, leads, CPL e CTR.",
      acao_passos: [] as string[],
      detalhes
    };
  }

  if (statusNormalizado === "CAMPAIGN_PAUSED") {
    return {
      tipo: "pausado",
      subcategoria: "campanha_pausada",
      motivo: "A campanha está pausada na Meta e os anúncios não estão sendo exibidos.",
      acao: "Use a chave no topo deste card para ativar a campanha.",
      acao_passos: [] as string[],
      detalhes
    };
  }

  if (statusNormalizado === "PAUSED") {
    const campanhaAtiva =
      ["ACTIVE", "ENABLED"].includes(
        String(campanhaStatusLocal || "").toUpperCase()
      );

    if (campanhaAtiva) {
      return {
        tipo: "pausado",
        subcategoria: "ad_pausado",
        motivo: "Os anúncios foram pausados diretamente na Meta, mas a campanha permanece ativa na plataforma.",
        acao: "Acesse os anúncios na Meta para ativá-los.",
        acao_passos: [
          "Clique em 'Ver anúncios na Meta' abaixo",
          "Localize o anúncio com status 'Pausado'",
          "Ative-o usando a chave ao lado do nome do anúncio",
          "Os anúncios voltam a veicular automaticamente"
        ],
        detalhes
      };
    }

    return {
      tipo: "pausado",
      subcategoria: "campanha_pausada",
      motivo: "A campanha está pausada e os anúncios não estão sendo exibidos.",
      acao: "Use a chave no topo deste card para ativar a campanha.",
      acao_passos: [] as string[],
      detalhes
    };
  }

  if (statusNormalizado === "ADSET_PAUSED") {
    return {
      tipo: "pausado",
      subcategoria: "adset_pausado",
      motivo: "O conjunto de anúncios está pausado na Meta. A campanha está ativa, mas os anúncios não veiculam.",
      acao: "Acesse os conjuntos de anúncios na Meta para ativar.",
      acao_passos: [
        "Clique em 'Ver conjuntos na Meta' abaixo",
        "Localize o conjunto de anúncios com status pausado",
        "Ative-o usando a chave ao lado do nome do conjunto",
        "Os anúncios voltam a veicular automaticamente"
      ],
      detalhes
    };
  }

  if (statusNormalizado === "WITH_ISSUES" || statusNormalizado === "PENDING_BILLING_INFO") {
    const textoDiagnostico =
      issueTexto ||
      erroPagamentoConta ||
      "A Meta encontrou um problema que impede ou limita a veiculação.";

    if (isBilling || statusNormalizado === "PENDING_BILLING_INFO") {
      return {
        tipo: "problema",
        subcategoria: "pagamento",
        motivo: textoDiagnostico,
        acao: "O método de pagamento da conta de anúncios precisa ser revisado.",
        acao_passos: [
          "Clique em 'Ver cobrança na Meta' abaixo",
          "Na seção de Cobrança, verifique se o cartão ou conta bancária está ativo",
          "Adicione saldo (pré-pago) ou atualize os dados do cartão",
          "Após corrigir, os anúncios retomam a veiculação automaticamente"
        ],
        detalhes
      };
    }

    if (isPolitica) {
      return {
        tipo: "problema",
        subcategoria: "politica",
        motivo: textoDiagnostico,
        acao: "Um ou mais anúncios foram sinalizados por violação de política da Meta.",
        acao_passos: [
          "Clique em 'Ver anúncios na Meta' abaixo",
          "Identifique o anúncio com ícone de aviso ou status 'Com problemas'",
          "Leia a notificação de política exibida pela Meta",
          "Edite o texto, imagem ou URL de destino conforme as diretrizes",
          "Salve e reenvie o anúncio para análise da Meta"
        ],
        detalhes
      };
    }

    return {
      tipo: "problema",
      subcategoria: "geral",
      motivo: textoDiagnostico,
      acao: "Acesse o Gerenciador de Anúncios para ver o detalhe do problema.",
      acao_passos: [
        "Clique em 'Abrir na Meta' abaixo",
        "Localize o ícone de aviso ao lado da campanha ou anúncio",
        "Leia a notificação e siga as instruções da Meta para resolver"
      ],
      detalhes
    };
  }

  if (statusNormalizado === "DISAPPROVED") {
    return {
      tipo: "problema",
      subcategoria: "reprovado",
      motivo: issueTexto || "O anúncio foi reprovado pela análise da Meta.",
      acao: "O anúncio precisa ser corrigido e reenviado para análise.",
      acao_passos: [
        "Clique em 'Ver anúncio na Meta' abaixo",
        "Leia o motivo da reprovação informado pela Meta",
        "Edite o criativo, texto ou URL de destino",
        "Certifique-se de que o conteúdo segue as políticas de anúncio da Meta",
        "Salve e reenvie para análise — o anúncio volta a veicular após aprovação"
      ],
      detalhes
    };
  }

  if (["PENDING_REVIEW", "IN_PROCESS", "PREAPPROVED"].includes(statusNormalizado)) {
    return {
      tipo: "analise",
      subcategoria: "em_analise",
      motivo: "A Meta está analisando o anúncio antes de iniciar a veiculação.",
      acao: "Nenhuma ação necessária agora. Aguarde a conclusão da análise.",
      acao_passos: [
        "Aguarde — a Meta geralmente conclui a análise em até 24 horas",
        "Se ultrapassar 24h, clique em 'Abrir na Meta' para verificar o status"
      ],
      detalhes
    };
  }

  return {
    tipo: "atencao",
    subcategoria: "outro",
    motivo: issueTexto || `Status retornado pela Meta: ${statusNormalizado}.`,
    acao: "Confira o Gerenciador de Anúncios para ver detalhes atualizados.",
    acao_passos: [
      "Clique em 'Abrir na Meta' abaixo",
      "Verifique o status da campanha e dos anúncios",
      "Siga as instruções exibidas pela Meta para normalizar a veiculação"
    ],
    detalhes
  };
}

// Extrai o saldo numérico de strings como "Saldo disponível (R$0,00 BRL)"
// ou "Saldo disponível (-R$91,46 BRL)" — preserva o sinal negativo.
function extrairSaldoDisponivelMeta(displayString?: string | null) {
  if (!displayString) return null;

  const match = displayString.match(/([\d.,]+)\s*[A-Z]{3}\)/);

  if (!match) return null;

  const saldo = Number(
    match[1].replace(/\./g, "").replace(",", ".")
  );

  if (Number.isNaN(saldo)) return null;

  // Verifica se há um "-" em qualquer posição antes dos dígitos capturados,
  // cobrindo formatos como "-R$91,46 BRL)" e "(-R$91,46 BRL)".
  const posDigitos = displayString.indexOf(match[1]);
  const negativo = displayString.slice(0, posDigitos).includes("-");

  return negativo ? -saldo : saldo;
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

async function listarCampaignIdsMetaDoUsuario(
  usuarioId: number,
  contaAnunciosId: string
) {
  const result = await client.query(
    `
    SELECT DISTINCT campaign_id
    FROM campanhas
    WHERE usuario_id = $1
      AND conta_anuncios_id = $2
      AND campaign_id IS NOT NULL
      AND COALESCE(status, '') <> 'DELETED'
      AND (
        ad_id IS NOT NULL
        OR adset_id IS NOT NULL
        OR form_id IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM leads l
          WHERE l.usuario_id = campanhas.usuario_id
            AND l.conta_anuncios_id = campanhas.conta_anuncios_id
            AND l.campanha = campanhas.nome
        )
      )
    `,
    [usuarioId, contaAnunciosId]
  );

  return new Set(
    result.rows
      .map((row: any) => String(row.campaign_id || ""))
      .filter(Boolean)
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



async function sincronizarCampanhasUsuario(
  usuarioId: number,
  token: string,
  contaAnunciosId: string
) {
  const campanhasMeta = await fetch(
    `https://graph.facebook.com/v19.0/${contaAnunciosId}/campaigns?fields=id,name,status,effective_status,objective&limit=500&access_token=${token}`
  ).then(r => r.json());

  if (!campanhasMeta.data) return;

  for (const campanha of campanhasMeta.data) {
    const statusFinal =
      campanha.status || campanha.effective_status || "UNKNOWN";

    const existe = await client.query(
      `SELECT id FROM campanhas WHERE campaign_id = $1 AND usuario_id = $2`,
      [campanha.id, usuarioId]
    );

    if (existe.rows.length > 0) {
      await client.query(
        `UPDATE campanhas
         SET nome = $1, status = $2, conta_anuncios_id = $3, atualizado_em = NOW()
         WHERE campaign_id = $4 AND usuario_id = $5`,
        [campanha.name, statusFinal, contaAnunciosId, campanha.id, usuarioId]
      );
    } else {
      await client.query(
        `INSERT INTO campanhas (usuario_id, campaign_id, conta_anuncios_id, nome, status, origem, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,'meta',NOW())`,
        [usuarioId, campanha.id, contaAnunciosId, campanha.name, statusFinal]
      );
    }
  }

  await client.query(
    `UPDATE meta_conexoes SET ultimo_sync = NOW() WHERE usuario_id = $1`,
    [usuarioId]
  );

  console.log(
    `✅ Sync usuário ${usuarioId}: ${campanhasMeta.data.length} campanhas`
  );
}

async function sincronizarTodasCampanhas() {

  try {

    console.log("🔄 AUTO SYNC INICIADO");

    const usuarios = await client.query(`
      SELECT DISTINCT ON (usuario_id)
        usuario_id,
        access_token,
        conta_anuncios_id
      FROM meta_conexoes
      WHERE conta_anuncios_id IS NOT NULL
      ORDER BY usuario_id, id DESC
    `);

    for (const user of usuarios.rows) {

      try {
        await sincronizarCampanhasUsuario(
          user.usuario_id,
          user.access_token,
          user.conta_anuncios_id
        );
      } catch (err) {
        console.error("ERRO USUÁRIO:", user.usuario_id, err);
      }

      // pequena pausa entre usuários para não sobrecarregar a API da Meta
      await new Promise(r => setTimeout(r, 2000));
    }

    console.log("🚀 AUTO SYNC FINALIZADO");

  } catch (err) {
    console.error("ERRO AUTO SYNC:", err);
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


app.put("/admin/usuarios/:id/parceiro", authMiddleware, async (c) => {

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
      SET is_parceiro = $1
      WHERE id = $2
    `, [
      !!body.is_parceiro,
      id
    ]);

    return c.json({
      success: true
    });

  } catch (err) {

    console.error("ERRO PARCEIRO:", err);

    return c.json({
      error: "Erro ao alterar parceiro"
    }, 500);
  }
});


app.put("/admin/usuarios/:id/vinculo-parceiro", authMiddleware, async (c) => {

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
      SET parceiro_id = $1
      WHERE id = $2
    `, [
      body.parceiro_id || null,
      id
    ]);

    return c.json({
      success: true
    });

  } catch (err) {

    console.error("ERRO VINCULO PARCEIRO:", err);

    return c.json({
      error: "Erro ao alterar vínculo de parceiro"
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
      state,
      locale: "pt_BR"
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

    // 💾 substitui conexão existente (evita duplicata)
    await client.query(
      "DELETE FROM meta_conexoes WHERE usuario_id = $1",
      [usuarioId]
    );
    await client.query(
      "INSERT INTO meta_conexoes (usuario_id, access_token) VALUES ($1, $2)",
      [usuarioId, access_token]
    );

    // Espelha no hub genérico de conexões
    await client.query(
      `INSERT INTO plataforma_conexoes (usuario_id, plataforma, status, access_token, conectado_em, atualizado_em)
       VALUES ($1, 'meta', 'conectado', $2, NOW(), NOW())
       ON CONFLICT (usuario_id, plataforma)
       DO UPDATE SET status = 'conectado', access_token = $2, atualizado_em = NOW()`,
      [usuarioId, access_token]
    );

    return c.html(`
      <script>
        if (window.opener) {
          window.opener.postMessage({ type: "meta_conectado" }, "*");
        }
        window.close();
      </script>
    `);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("ERRO META CALLBACK:", msg, err);
    return c.text(`Erro ao conectar Meta: ${msg}`);
  }
});


/* =========================
   🔌 OAUTH GENÉRICO — demais plataformas de anúncio
   Google, TikTok, LinkedIn, Pinterest, Snapchat, Microsoft, Kwai.
   Aguardando credenciais aprovadas por cada rede. Quando o
   client_id/secret/redirect_uri de uma plataforma forem configurados
   nas envs (ver *_CLIENT_ID/*_CLIENT_SECRET/*_REDIRECT_URI abaixo),
   o fluxo de conexao passa a funcionar sem mais nenhuma mudanca aqui.
========================= */

const OAUTH_PROVEDORES: Record<string, {
  authUrl: string;
  tokenUrl: string;
  scope: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  redirectUriEnv: string;
  extraAuthParams?: Record<string, string>;
}> = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/adwords",
    clientIdEnv: "GOOGLE_ADS_CLIENT_ID",
    clientSecretEnv: "GOOGLE_ADS_CLIENT_SECRET",
    redirectUriEnv: "GOOGLE_ADS_REDIRECT_URI",
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  tiktok: {
    authUrl: "https://business-api.tiktok.com/portal/auth",
    tokenUrl: "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/",
    scope: "",
    clientIdEnv: "TIKTOK_ADS_APP_ID",
    clientSecretEnv: "TIKTOK_ADS_APP_SECRET",
    redirectUriEnv: "TIKTOK_ADS_REDIRECT_URI",
  },
  linkedin: {
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scope: "r_ads r_ads_reporting rw_ads",
    clientIdEnv: "LINKEDIN_ADS_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_ADS_CLIENT_SECRET",
    redirectUriEnv: "LINKEDIN_ADS_REDIRECT_URI",
  },
  pinterest: {
    authUrl: "https://www.pinterest.com/oauth/",
    tokenUrl: "https://api.pinterest.com/v5/oauth/token",
    scope: "ads:read,ads:write",
    clientIdEnv: "PINTEREST_ADS_APP_ID",
    clientSecretEnv: "PINTEREST_ADS_APP_SECRET",
    redirectUriEnv: "PINTEREST_ADS_REDIRECT_URI",
  },
  snapchat: {
    authUrl: "https://accounts.snapchat.com/login/oauth2/authorize",
    tokenUrl: "https://accounts.snapchat.com/login/oauth2/access_token",
    scope: "snapchat-marketing-api",
    clientIdEnv: "SNAPCHAT_ADS_CLIENT_ID",
    clientSecretEnv: "SNAPCHAT_ADS_CLIENT_SECRET",
    redirectUriEnv: "SNAPCHAT_ADS_REDIRECT_URI",
  },
  microsoft: {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "https://ads.microsoft.com/msads.manage offline_access",
    clientIdEnv: "MICROSOFT_ADS_CLIENT_ID",
    clientSecretEnv: "MICROSOFT_ADS_CLIENT_SECRET",
    redirectUriEnv: "MICROSOFT_ADS_REDIRECT_URI",
  },
  kwai: {
    // Kwai ainda nao publica um fluxo OAuth self-service documentado;
    // authUrl/tokenUrl ficam vazios de proposito ate isso existir.
    authUrl: "",
    tokenUrl: "",
    scope: "",
    clientIdEnv: "KWAI_ADS_CLIENT_ID",
    clientSecretEnv: "KWAI_ADS_CLIENT_SECRET",
    redirectUriEnv: "KWAI_ADS_REDIRECT_URI",
  },
};

function gerarOAuthStateGenerico() {
  return base64Url(randomBytes(32));
}
function hashOAuthStateGenerico(state: string) {
  return assinarPayload(`plataforma-oauth-state:${state}`);
}

app.get("/auth/:plataforma/login", async (c) => {
  const plataforma = c.req.param("plataforma");
  const cfg = OAUTH_PROVEDORES[plataforma];
  if (!cfg) return c.text("Plataforma nao suporta conexao OAuth", 404);

  try {
    const token = c.req.query("token");
    if (!token) return c.text("Token nao enviado", 400);

    const usuario = decodificarTokenUsuario(token);
    if (!usuario?.id) return c.text("Token invalido ou expirado", 401);

    const clientId    = Bun.env[cfg.clientIdEnv];
    const redirectUri = Bun.env[cfg.redirectUriEnv];

    if (!clientId || !redirectUri || !cfg.authUrl) {
      return c.text(
        `Integracao com ${plataforma} ainda nao configurada (credenciais pendentes de aprovacao da plataforma).`,
        503
      );
    }

    const state = gerarOAuthStateGenerico();
    const stateHash = hashOAuthStateGenerico(state);

    await client.query(
      `DELETE FROM plataforma_oauth_states WHERE expira_em <= NOW() OR usado_em IS NOT NULL`
    );
    await client.query(
      `INSERT INTO plataforma_oauth_states (state_hash, usuario_id, plataforma, expira_em)
       VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval)`,
      [stateHash, usuario.id, plataforma, META_OAUTH_STATE_TTL_MINUTES]
    );

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: cfg.scope,
      state,
      ...(cfg.extraAuthParams || {}),
    });

    return c.redirect(`${cfg.authUrl}?${params.toString()}`);
  } catch (err) {
    console.error(`ERRO /auth/${plataforma}/login:`, err);
    return c.text("Token invalido ou expirado", 401);
  }
});

app.get("/auth/:plataforma/callback", async (c) => {
  const plataforma = c.req.param("plataforma");
  const cfg = OAUTH_PROVEDORES[plataforma];
  if (!cfg) return c.text("Plataforma nao suporta conexao OAuth", 404);

  try {
    const code  = c.req.query("code");
    const state = c.req.query("state");
    if (!state) return c.text("State nao recebido", 400);
    if (!code)  return c.text("Erro: code nao recebido", 400);

    const clientId     = Bun.env[cfg.clientIdEnv];
    const clientSecret = Bun.env[cfg.clientSecretEnv];
    const redirectUri   = Bun.env[cfg.redirectUriEnv];

    if (!clientId || !clientSecret || !redirectUri) {
      return c.text(`Configuracao de ${plataforma} incompleta`, 500);
    }

    const stateHash = hashOAuthStateGenerico(state);
    const db = await client.connect();
    let usuarioId: number | null = null;

    try {
      await db.query("BEGIN");

      const stateResult = await db.query(
        `SELECT id, usuario_id FROM plataforma_oauth_states
         WHERE state_hash = $1 AND plataforma = $2 AND usado_em IS NULL AND expira_em > NOW()
         LIMIT 1 FOR UPDATE`,
        [stateHash, plataforma]
      );

      if (stateResult.rows.length === 0) {
        await db.query("ROLLBACK");
        return c.text("State invalido ou expirado", 401);
      }

      usuarioId = Number(stateResult.rows[0].usuario_id);

      await db.query(
        `UPDATE plataforma_oauth_states SET usado_em = NOW() WHERE id = $1`,
        [stateResult.rows[0].id]
      );

      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    } finally {
      db.release();
    }

    // TikTok usa JSON body e estrutura de resposta diferente do padrão OAuth2
    let access_token: string;
    let refresh_token: string | null = null;
    let dadosConta: Record<string, any> = {};

    if (plataforma === "tiktok") {
      const tokenRes = await fetch(cfg.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: clientId,
          auth_code: code,
          secret: clientSecret,
        }),
      });
      const tokenData = await tokenRes.json() as any;
      if (tokenData.code !== 0 || !tokenData.data?.access_token) {
        console.error("ERRO TOKEN TIKTOK:", tokenData);
        return c.text("Erro ao obter token TikTok", 502);
      }
      access_token = tokenData.data.access_token;
      refresh_token = tokenData.data.refresh_token ?? null;
      const advertiserIds: string[] = tokenData.data.advertiser_ids ?? [];
      dadosConta = { advertiser_ids: advertiserIds };
    } else {
      const tokenRes = await fetch(cfg.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      const tokenData = await tokenRes.json() as any;
      if (!tokenRes.ok || !tokenData.access_token) {
        console.error(`ERRO TOKEN ${plataforma.toUpperCase()}:`, tokenData);
        return c.text(`Erro ao obter token de ${plataforma}`, 502);
      }
      access_token = tokenData.access_token;
      refresh_token = tokenData.refresh_token ?? null;
    }

    if (!usuarioId) {
      return c.text("Usuario invalido", 401);
    }

    await client.query(
      `INSERT INTO plataforma_conexoes
         (usuario_id, plataforma, status, access_token, refresh_token, dados_conta, conectado_em, atualizado_em)
       VALUES ($1, $2, 'conectado', $3, $4, $5, NOW(), NOW())
       ON CONFLICT (usuario_id, plataforma)
       DO UPDATE SET status = 'conectado', access_token = $3, refresh_token = $4,
                     dados_conta = $5, atualizado_em = NOW()`,
      [usuarioId, plataforma, access_token, refresh_token, JSON.stringify(dadosConta)]
    );

    return c.html(`
      <script>
        if (window.opener) {
          window.opener.postMessage({ type: "plataforma_conectada", plataforma: "${plataforma}" }, "*");
        }
        window.close();
      </script>
    `);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERRO CALLBACK ${plataforma.toUpperCase()}:`, msg, err);
    return c.text(`Erro ao conectar ${plataforma}: ${msg}`);
  }
});

/* =========================
   🎵 TIKTOK ADS
========================= */

const tiktokSyncEmAndamento = new Set<number>();

const TIKTOK_API = "https://business-api.tiktok.com/open_api/v1.3";

function tiktokHeaders(token: string) {
  return { "Access-Token": token, "Content-Type": "application/json" };
}

// Lista contas de anunciante vinculadas ao token
app.get("/tiktok/anunciantes", authMiddleware, async (c) => {
  const user: any = c.get("user");
  try {
    const conn = await client.query(
      `SELECT access_token, dados_conta FROM plataforma_conexoes
       WHERE usuario_id = $1 AND plataforma = 'tiktok' LIMIT 1`,
      [user.id]
    );
    if (!conn.rows.length) return c.json({ error: "TikTok nao conectado" }, 400);

    const token = conn.rows[0].access_token;
    const dadosConta = conn.rows[0].dados_conta ?? {};
    const advertiserIds: string[] = dadosConta.advertiser_ids ?? [];

    if (!advertiserIds.length) {
      return c.json({ error: "Nenhuma conta de anunciante encontrada" }, 400);
    }

    const clientId = Bun.env.TIKTOK_ADS_APP_ID;
    const clientSecret = Bun.env.TIKTOK_ADS_APP_SECRET;
    if (!clientId || !clientSecret) return c.json({ error: "Credenciais TikTok nao configuradas" }, 500);

    const params = new URLSearchParams({
      app_id: clientId,
      secret: clientSecret,
      access_token: token,
    });
    const res = await fetch(`${TIKTOK_API}/oauth2/advertiser/get/?${params}`);
    const data = await res.json() as any;

    if (data.code !== 0) {
      console.error("ERRO TIKTOK ANUNCIANTES:", data);
      return c.json({ error: "Erro ao buscar anunciantes TikTok" }, 502);
    }

    return c.json({ anunciantes: data.data?.list ?? [] });
  } catch (err: any) {
    console.error("ERRO /tiktok/anunciantes:", err);
    return c.json({ error: "Erro interno" }, 500);
  }
});

// Salva o anunciante selecionado pelo usuário
app.post("/tiktok/selecionar-anunciante", authMiddleware, async (c) => {
  const user: any = c.get("user");
  try {
    const { advertiser_id } = await c.req.json();
    if (!advertiser_id) return c.json({ error: "advertiser_id obrigatorio" }, 400);

    await client.query(
      `UPDATE plataforma_conexoes
       SET dados_conta = COALESCE(dados_conta, '{}'::jsonb) || jsonb_build_object('advertiser_id', $1::text),
           atualizado_em = NOW()
       WHERE usuario_id = $2 AND plataforma = 'tiktok'`,
      [String(advertiser_id), user.id]
    );
    return c.json({ sucesso: true });
  } catch (err: any) {
    console.error("ERRO /tiktok/selecionar-anunciante:", err);
    return c.json({ error: "Erro interno" }, 500);
  }
});

// Sincroniza campanhas e leads do TikTok Ads
app.post("/tiktok/sincronizar-campanhas", authMiddleware, async (c) => {
  const user: any = c.get("user");
  try {
    if (tiktokSyncEmAndamento.has(user.id)) {
      return c.json({ error: "Sincronizacao TikTok ja em andamento" }, 429);
    }
    tiktokSyncEmAndamento.add(user.id);

    const conn = await client.query(
      `SELECT access_token, dados_conta FROM plataforma_conexoes
       WHERE usuario_id = $1 AND plataforma = 'tiktok' LIMIT 1`,
      [user.id]
    );
    if (!conn.rows.length) return c.json({ error: "TikTok nao conectado" }, 400);

    const token = conn.rows[0].access_token;
    const dadosConta = conn.rows[0].dados_conta ?? {};
    const advertiserId = dadosConta.advertiser_id;

    if (!advertiserId) {
      return c.json({ error: "Selecione a conta de anunciante TikTok antes de sincronizar" }, 400);
    }

    // 🔥 BUSCA CAMPANHAS
    const campanhasRes = await fetch(
      `${TIKTOK_API}/campaign/get/?advertiser_id=${advertiserId}&fields=["campaign_id","campaign_name","status","objective_type"]&page_size=100`,
      { headers: tiktokHeaders(token) }
    );
    const campanhasData = await campanhasRes.json() as any;

    if (campanhasData.code !== 0) {
      console.error("ERRO CAMPANHAS TIKTOK:", campanhasData);
      return c.json({ error: "Erro ao buscar campanhas TikTok", detalhe: campanhasData.message }, 502);
    }

    const campanhas = campanhasData.data?.list ?? [];
    console.log("TIKTOK CAMPANHAS:", campanhas.length);

    for (const campanha of campanhas) {
      const existe = await client.query(
        `SELECT id FROM campanhas WHERE campaign_id = $1 AND usuario_id = $2`,
        [String(campanha.campaign_id), user.id]
      );

      if (existe.rows.length > 0) {
        await client.query(
          `UPDATE campanhas SET nome = $1, status = $2, atualizado_em = NOW()
           WHERE campaign_id = $3 AND usuario_id = $4`,
          [campanha.campaign_name, campanha.status, String(campanha.campaign_id), user.id]
        );
      } else {
        await client.query(
          `INSERT INTO campanhas (usuario_id, campaign_id, conta_anuncios_id, nome, status, origem, plataforma, atualizado_em)
           VALUES ($1, $2, $3, $4, $5, 'tiktok', 'tiktok', NOW())`,
          [user.id, String(campanha.campaign_id), String(advertiserId), campanha.campaign_name, campanha.status]
        );
      }
    }

    // 🔥 BUSCA LEADS (últimos 30 dias)
    const trintaDiasAtras = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const startTime = Math.floor(trintaDiasAtras.getTime() / 1000);

    let page = 1;
    let totalLeads = 0;
    let hasMore = true;

    while (hasMore) {
      const leadsRes = await fetch(
        `${TIKTOK_API}/lead/get/?advertiser_id=${advertiserId}&start_time=${startTime}&page=${page}&page_size=100`,
        { headers: tiktokHeaders(token) }
      );
      const leadsData = await leadsRes.json() as any;

      if (leadsData.code !== 0) {
        console.error("ERRO LEADS TIKTOK:", leadsData);
        break;
      }

      const leadsList = leadsData.data?.list ?? [];
      const pageInfo = leadsData.data?.page_info ?? {};
      hasMore = page < Math.ceil((pageInfo.total_number ?? 0) / 100);
      page++;

      for (const lead of leadsList) {
        const leadId = String(lead.lead_id);
        const formId = String(lead.form_id ?? "");

        const jaExiste = await client.query(
          `SELECT id FROM leads WHERE lead_id = $1 AND usuario_id = $2`,
          [leadId, user.id]
        );
        if (jaExiste.rows.length > 0) continue;

        // Identifica campanha pelo form_id, se disponível
        let nomeCampanha = "Campanha TikTok";
        let nichoId: number | null = null;
        if (formId) {
          const campRow = await client.query(
            `SELECT nome, nicho_id FROM campanhas WHERE form_id = $1 AND usuario_id = $2 LIMIT 1`,
            [formId, user.id]
          );
          if (campRow.rows.length) {
            nomeCampanha = campRow.rows[0].nome;
            nichoId = campRow.rows[0].nicho_id ?? null;
          }
        }

        let nome = "";
        let email = "";
        let telefone = "";
        const respostasQualificacao: any[] = [];

        for (const field of lead.fields ?? []) {
          const key = (field.name ?? "").toUpperCase();
          if (key === "FULL_NAME" || key === "FIRST_NAME") nome = field.value ?? "";
          else if (key === "EMAIL") email = field.value ?? "";
          else if (key === "PHONE_NUMBER") telefone = field.value ?? "";
          else respostasQualificacao.push({ pergunta: field.name, resposta: field.value ?? "" });
        }

        const criadoEm = lead.submit_time
          ? new Date(Number(lead.submit_time) * 1000).toISOString()
          : null;

        await client.query(
          `INSERT INTO leads
             (usuario_id, lead_id, nome, email, telefone, campanha, conta_anuncios_id,
              origem, plataforma, status, respostas_qualificacao, nicho_id, criado_em)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'tiktok','tiktok','novo',$8,$9,COALESCE($10::timestamptz, NOW()))`,
          [
            user.id, leadId, nome || "Lead TikTok", email, telefone,
            nomeCampanha, String(advertiserId),
            JSON.stringify(respostasQualificacao), nichoId, criadoEm
          ]
        );

        await notificarNovoLeadWhatsApp(user.id, { nome, telefone, email, campanha: nomeCampanha });
        totalLeads++;
      }
    }

    await client.query(
      `UPDATE plataforma_conexoes SET atualizado_em = NOW()
       WHERE usuario_id = $1 AND plataforma = 'tiktok'`,
      [user.id]
    );

    return c.json({ sucesso: true, campanhas: campanhas.length, leads_novos: totalLeads });
  } catch (err: any) {
    console.error("ERRO TIKTOK SINCRONIZAR:", err);
    return c.json({ error: "Erro ao sincronizar TikTok" }, 500);
  } finally {
    tiktokSyncEmAndamento.delete(user.id);
  }
});

/* =========================
   📷 INSTAGRAM LOGIN (Business Login)
========================= */

// 🔹 REDIRECIONA PARA LOGIN INSTAGRAM (Instagram API with Instagram Login)
app.get("/auth/meta/instagram/login", async (c) => {
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

  const clientId = Bun.env.INSTAGRAM_APP_ID;
  const redirectUri = Bun.env.INSTAGRAM_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return c.text("Configuracao Instagram incompleta", 500);
  }

  // State temporario de uso unico para o OAuth do Instagram.
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

  const params =
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "instagram_business_basic",
      state
    });

  const url =
    `https://www.instagram.com/oauth/authorize?${params.toString()}`;

  return c.redirect(url);
  } catch (err) {
    console.error("ERRO LOGIN INSTAGRAM:", err);
    return c.text("Erro ao iniciar conexao Instagram", 500);
  }
});


// 🔹 CALLBACK (SALVA CONTA DO INSTAGRAM)
app.get("/auth/meta/instagram/callback", async (c) => {
  try {
    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!state) {
      return c.text("State nao recebido");
    }

    if (!code) {
      return c.text("Erro: code não recebido");
    }

    const clientId = Bun.env.INSTAGRAM_APP_ID;
    const clientSecret = Bun.env.INSTAGRAM_APP_SECRET;
    const redirectUri = Bun.env.INSTAGRAM_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      return c.text("Configuracao Instagram incompleta", 500);
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

    if (!usuarioId) {
      return c.text("Usuário inválido", 401);
    }

    const conexao = await client.query(
      "SELECT id FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1",
      [usuarioId]
    );

    if (conexao.rows.length === 0) {
      return c.html(`
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: "instagram_erro", erro: "Conecte sua conta Meta antes de vincular o Instagram." }, "*");
          }
          window.close();
        </script>
      `);
    }

    // 🔥 troca code por token de curta duracao
    const shortTokenForm = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code
    });

    const shortTokenRes = await fetch(
      "https://api.instagram.com/oauth/access_token",
      {
        method: "POST",
        body: shortTokenForm
      }
    );

    const shortTokenData = await shortTokenRes.json();

    if (!shortTokenRes.ok || !shortTokenData.access_token) {
      console.error("ERRO TOKEN INSTAGRAM:", shortTokenData);
      return c.text("Erro ao obter token Instagram", 502);
    }

    console.log(
      "INSTAGRAM SHORT TOKEN OK. user_id:",
      shortTokenData.user_id
    );

    // 🔥 troca por token de longa duracao
    const longParams =
      new URLSearchParams({
        grant_type: "ig_exchange_token",
        client_secret: clientSecret,
        access_token: shortTokenData.access_token
      });

    const longTokenData = await fetch(
      `https://graph.instagram.com/access_token?${longParams.toString()}`
    ).then(r => r.json());

    console.log(
      "INSTAGRAM LONG TOKEN:",
      JSON.stringify({
        ok: Boolean(longTokenData.access_token),
        error: longTokenData.error
      })
    );

    const access_token =
      longTokenData.access_token || shortTokenData.access_token;

    // 🔥 BUSCA PERFIL DA CONTA DO INSTAGRAM
    const perfil = await fetch(
      `https://graph.instagram.com/v21.0/me?fields=user_id,username,account_type,profile_picture_url&access_token=${encodeURIComponent(access_token)}`
    ).then(r => r.json());

    console.log("INSTAGRAM LOGIN PERFIL:", JSON.stringify(perfil));

    if (!perfil.user_id) {
      console.error("INSTAGRAM LOGIN: perfil invalido", perfil);
      return c.html(`
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: "instagram_erro", erro: "Não foi possível obter os dados da conta do Instagram." }, "*");
          }
          window.close();
        </script>
      `);
    }

    console.log("INSTAGRAM conectado com sucesso:", perfil.username);

    // 💾 salva no banco
    await client.query(
      `
      UPDATE meta_conexoes
      SET instagram_id = $1,
          instagram_username = $2,
          instagram_profile_picture_url = $3,
          instagram_token = $4,
          instagram_conectado_em = NOW()
      WHERE id = $5
      `,
      [
        perfil.user_id,
        perfil.username || null,
        perfil.profile_picture_url || null,
        access_token,
        conexao.rows[0].id
      ]
    );

    return c.html(`
      <script>
        if (window.opener) {
          window.opener.postMessage({ type: "instagram_conectado" }, "*");
        }
        window.close();
      </script>
    `);

  } catch (err) {
    console.error("ERRO INSTAGRAM:", err);
    return c.text("Erro ao conectar Instagram");
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

    // importa campanhas existentes da Meta em background (primeira conexão)
    sincronizarCampanhasUsuario(
      user.id,
      conn.rows[0].access_token,
      conta.id
    ).catch(err =>
      console.error("Erro importação inicial Meta:", err)
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
      configuracoes_avancadas,
      nicho_id,
      cbo,
      daily_budget: dailyBudgetCampanha
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
    
    const payloadCampanha: any = {
      name: nome || "Campanha Leads Plataforma",
      objective: objetivo || "OUTCOME_LEADS",
      status: "PAUSED",
      special_ad_categories: specialAdCategories,
      is_adset_budget_sharing_enabled: false,
      access_token: token
    };

    // CBO: orçamento gerenciado pela campanha em vez de cada adset
    if (cbo) {
      if (dailyBudgetCampanha) {
        payloadCampanha.daily_budget = dailyBudgetCampanha;
      }
    }

    const campanha = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/campaigns`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadCampanha)
      }
    ).then(r => r.json());

    if (!campanha.id) {

      const metaMsg =
        campanha?.error?.error_user_msg ||
        campanha?.error?.message ||
        null;

      return c.json({
        error: metaMsg || "Erro ao criar campanha na Meta",
        codigo_meta: campanha?.error?.code ?? null,
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
        configuracoes_avancadas,
        nicho_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [
        usuarioId,
        campanha.id,
        adAccountId,
        nome || "Campanha Plataforma",
        "PAUSED",
        "plataforma",
        JSON.stringify({
          ...(configuracoes_avancadas || {}),
          cbo: Boolean(cbo)
        }),
        nicho_id ?? null
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

    // Públicos personalizados/lookalike selecionados para o adset
    const publicosPersonalizados =
      Array.isArray(avancadas.custom_audiences)
        ? avancadas.custom_audiences
            .map((id: any) => ({ id: String(id) }))
            .filter((p: any) => p.id)
        : [];

    if (publicosPersonalizados.length) {
      targeting.custom_audiences = publicosPersonalizados;
    }

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

    const { bidStrategy, bidAmount } =
      prepararControleCustoMeta(
        avancadas.bid_strategy,
        avancadas.bid_amount
      );

    const payloadAdset: any = {
      name: `AdSet Leads ${Date.now()}`,

      campaign_id,

      billing_event: "IMPRESSIONS",

      optimization_goal: "LEAD_GENERATION",

      destination_type: "ON_AD",

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

    if (bidStrategy) {
      payloadAdset.bid_strategy = bidStrategy;
    }

    // Só define budget no adset quando NÃO há CBO (com CBO o budget fica na campanha)
    if (daily_budget) {
      payloadAdset.daily_budget = daily_budget;
    }

    if (fim) {
      payloadAdset.end_time =
        new Date(fim).toISOString();
    }

    if (
      bidAmount !== null &&
      bidStrategyExigeValor(bidStrategy)
    ) {
      payloadAdset.bid_amount =
        Math.round(bidAmount * 100);
    }

    // Janela de atribuição: define quantos dias após clique/visualização a Meta conta a conversão
    const atribuicao =
      textoOpcional(avancadas.attribution_spec);

    if (atribuicao) {
      const janelasValidas: Record<string, object> = {
        "1d_click": [{ event_type: "CLICK_THROUGH", window_days: 1 }],
        "7d_click": [{ event_type: "CLICK_THROUGH", window_days: 7 }],
        "28d_click": [{ event_type: "CLICK_THROUGH", window_days: 28 }],
        "1d_click_1d_view": [
          { event_type: "CLICK_THROUGH", window_days: 1 },
          { event_type: "VIEW_THROUGH", window_days: 1 }
        ],
        "7d_click_1d_view": [
          { event_type: "CLICK_THROUGH", window_days: 7 },
          { event_type: "VIEW_THROUGH", window_days: 1 }
        ]
      };

      if (janelasValidas[atribuicao]) {
        payloadAdset.attribution_spec = janelasValidas[atribuicao];
      }
    }

    let adset = await enviarPayloadMetaComFallbackBid(
      `https://graph.facebook.com/v19.0/${adAccountId}/adsets`,
      payloadAdset,
      "ADSET"
    );

    console.log(
      "ADSET PAYLOAD:",
      JSON.stringify(payloadAdset, null, 2)
    );

    console.log("ADSET RESPONSE:", adset);

    // Se a janela de atribuição enviada for incompatível com o objetivo, tenta sem ela
    if (adset.error && payloadAdset.attribution_spec) {
      const errMsg = (
        adset.error?.error_user_msg ||
        adset.error?.message ||
        ""
      ).toLowerCase();
      if (
        errMsg.includes("attribution") ||
        errMsg.includes("atribuição") ||
        errMsg.includes("atribuicao")
      ) {
        console.log(
          "ADSET: attribution_spec rejeitada pela Meta, tentando sem ela..."
        );
        delete payloadAdset.attribution_spec;
        adset = await enviarPayloadMetaComFallbackBid(
          `https://graph.facebook.com/v19.0/${adAccountId}/adsets`,
          payloadAdset,
          "ADSET_RETRY_ATTRIBUTION"
        );
        console.log("ADSET RETRY RESPONSE:", adset);
      }
    }

    if (adset.error) {
      const metaMsgAdset =
        adset.error?.error_user_msg ||
        adset.error?.message ||
        null;
      return c.json({
        error: metaMsgAdset || "Erro ao criar conjunto de anúncios",
        codigo_meta: adset.error?.code ?? null,
        detalhe: adset.error,
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
        .slice(0, 4)
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

    if (form.error) {
      const metaMsgForm =
        form.error?.error_user_msg ||
        form.error?.message ||
        null;
      return c.json({
        error: metaMsgForm || "Erro ao criar formulário na Meta",
        codigo_meta: form.error?.code ?? null,
        detalhe: form.error
      }, 400);
    }

    return c.json(form);

  } catch (err) {
    console.error("ERRO FORM:", err);
    return c.json({ error: "Erro ao criar formulário" }, 500);
  }
});

// ─── PÚBLICOS PERSONALIZADOS ──────────────────────────────────────────────────

// Lista públicos personalizados existentes na conta de anúncios
app.get("/meta/publicos", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const usuarioId = resolverUsuarioIdOperacao(user, c.req.query("usuario_id"));
    if (!usuarioId) return negarAcessoConta(c);

    const conn = await client.query(
      "SELECT access_token, conta_anuncios_id FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1",
      [usuarioId]
    );
    if (!conn.rows.length) return c.json({ error: "Meta não conectada" }, 400);

    const token = conn.rows[0].access_token;
    const contaAds = await obterContaAnuncios(token, conn.rows[0].conta_anuncios_id);
    if (!contaAds) return c.json({ error: "Conta de anúncios não encontrada" }, 400);

    const resp = await fetch(
      `https://graph.facebook.com/v19.0/${contaAds.id}/customaudiences?fields=id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound&limit=50&access_token=${token}`
    ).then(r => r.json());

    return c.json({ publicos: resp.data || [] });
  } catch (err) {
    return c.json({ error: "Erro ao listar públicos" }, 500);
  }
});

// Cria público personalizado a partir dos leads da conta (upload de lista de emails/telefones)
app.post("/meta/publico-personalizado", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const { usuario_id, nome } = await c.req.json();
    const usuarioId = resolverUsuarioIdOperacao(user, usuario_id);
    if (!usuarioId) return negarAcessoConta(c);

    const conn = await client.query(
      "SELECT access_token, conta_anuncios_id FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1",
      [usuarioId]
    );
    if (!conn.rows.length) return c.json({ error: "Meta não conectada" }, 400);

    const token = conn.rows[0].access_token;
    const contaAds = await obterContaAnuncios(token, conn.rows[0].conta_anuncios_id);
    if (!contaAds) return c.json({ error: "Conta de anúncios não encontrada" }, 400);

    const leadsRes = await client.query(
      "SELECT email, telefone FROM leads WHERE usuario_id = $1 AND (email IS NOT NULL OR telefone IS NOT NULL) LIMIT 5000",
      [usuarioId]
    );

    if (leadsRes.rows.length < 100) {
      return c.json({
        error: "São necessários pelo menos 100 leads com email ou telefone para criar um público personalizado."
      }, 400);
    }

    const criacao = await fetch(
      `https://graph.facebook.com/v19.0/${contaAds.id}/customaudiences`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nome || `Leads Plataforma ${new Date().toLocaleDateString("pt-BR")}`,
          subtype: "CUSTOM",
          description: "Público criado automaticamente a partir dos leads da plataforma",
          customer_file_source: "USER_PROVIDED_ONLY",
          access_token: token
        })
      }
    ).then(r => r.json());

    if (!criacao.id) {
      return c.json({ error: "Erro ao criar público", detalhe: criacao }, 400);
    }

    // A Meta exige dados hasheados com SHA-256
    const crypto = await import("crypto");
    const hashear = (v: string) =>
      crypto.createHash("sha256").update(v.trim().toLowerCase()).digest("hex");

    const schema = ["EMAIL", "PHONE"];
    const data = leadsRes.rows.map((row: any) => [
      row.email ? hashear(row.email) : "",
      row.telefone ? hashear(row.telefone.replace(/\D/g, "")) : ""
    ]);

    const upload = await fetch(
      `https://graph.facebook.com/v19.0/${criacao.id}/users`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload: { schema, data },
          access_token: token
        })
      }
    ).then(r => r.json());

    return c.json({
      id: criacao.id,
      nome: nome || "Leads Plataforma",
      total_leads: leadsRes.rows.length,
      upload
    });
  } catch (err) {
    console.error("ERRO PUBLICO PERSONALIZADO:", err);
    return c.json({ error: "Erro ao criar público personalizado" }, 500);
  }
});

// Cria público lookalike a partir de um público personalizado existente
app.post("/meta/lookalike", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const { usuario_id, publico_origem_id, pais, tamanho } = await c.req.json();
    const usuarioId = resolverUsuarioIdOperacao(user, usuario_id);
    if (!usuarioId) return negarAcessoConta(c);

    const conn = await client.query(
      "SELECT access_token, conta_anuncios_id FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1",
      [usuarioId]
    );
    if (!conn.rows.length) return c.json({ error: "Meta não conectada" }, 400);

    const token = conn.rows[0].access_token;
    const contaAds = await obterContaAnuncios(token, conn.rows[0].conta_anuncios_id);
    if (!contaAds) return c.json({ error: "Conta de anúncios não encontrada" }, 400);

    // tamanho: 1–10 (%) — 1 = mais parecido com os leads, 10 = mais amplo
    const tamanhoValido = Math.min(10, Math.max(1, Number(tamanho) || 2));

    const lookalike = await fetch(
      `https://graph.facebook.com/v19.0/${contaAds.id}/customaudiences`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Lookalike ${tamanhoValido}% — Leads Plataforma`,
          subtype: "LOOKALIKE",
          origin_audience_id: publico_origem_id,
          lookalike_spec: {
            type: "similarity",
            ratio: tamanhoValido / 100,
            country: textoOpcional(pais)?.toUpperCase().slice(0, 2) || "BR"
          },
          access_token: token
        })
      }
    ).then(r => r.json());

    if (!lookalike.id) {
      return c.json({ error: "Erro ao criar lookalike", detalhe: lookalike }, 400);
    }

    return c.json(lookalike);
  } catch (err) {
    console.error("ERRO LOOKALIKE:", err);
    return c.json({ error: "Erro ao criar público lookalike" }, 500);
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

    // 🔥 CONTA DE ANÚNCIOS — usa a selecionada ou a única disponível
    let contaAnunciosId = conn.rows[0].conta_anuncios_id;

    if (!contaAnunciosId) {
      contaAnunciosId = await obterContaAnunciosSelecionadaIdUsuario(usuarioId);
    }

    const contaAds =
      await obterContaAnuncios(
        token,
        contaAnunciosId
      );

    if (!contaAds) {

      return c.json({
        error: "Conta de anúncios não encontrada. Selecione a conta Meta no painel de conexão."
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
    const urlImagem =
      primeiraImagem?.url ||
      primeiraImagem?.url_128 ||
      primeiraImagem?.permalink_url ||
      primeiraImagem?.original_url ||
      null;

    if (!hash) {

      return c.json({
        error: "Erro upload imagem",
        detalhe: upload
      }, 400);
    }

    return c.json({
      sucesso: true,
      hash,
      url: urlImagem
    });

  } catch (err: any) {

    console.error("UPLOAD IMAGEM:", err?.message || err);

    return c.json({
      error: err?.message || "Erro upload imagem"
    }, 500);
  }
});


app.post("/meta/upload-video", authMiddleware, async (c) => {

  try {
    const user: any = c.get("user");
    const body = await c.req.formData();

    const video = body.get("video") as File;
    const usuario_id = body.get("usuario_id");
    const nomeInformado =
      String(body.get("nome") || video?.name || "video-campanha.mp4");

    const usuarioId =
      resolverUsuarioIdOperacao(user, usuario_id);

    if (!usuarioId) {
      return negarAcessoConta(c);
    }

    if (!video) {
      return c.json({
        error: "Vídeo não enviado"
      }, 400);
    }

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
    let contaAnunciosId = conn.rows[0].conta_anuncios_id;

    if (!contaAnunciosId) {
      contaAnunciosId = await obterContaAnunciosSelecionadaIdUsuario(usuarioId);
    }

    const contaAds =
      await obterContaAnuncios(
        token,
        contaAnunciosId
      );

    if (!contaAds) {
      return c.json({
        error: "Conta de anúncios não encontrada. Selecione a conta Meta no painel de conexão."
      }, 400);
    }

    const metaForm = new FormData();

    metaForm.append(
      "source",
      video,
      nomeInformado
    );

    metaForm.append(
      "access_token",
      token
    );

    const response = await fetch(
      `https://graph.facebook.com/v19.0/${contaAds.id}/advideos`,
      {
        method: "POST",
        body: metaForm
      }
    );

    const texto = await response.text();
    let upload: any = {};

    try {
      upload = JSON.parse(texto);
    } catch (_) {
      upload = { raw: texto };
    }

    if (!response.ok || !upload.id) {
      const metaMsg =
        upload?.error?.error_user_msg ||
        upload?.error?.message ||
        "Erro ao enviar vídeo para a Meta";

      return c.json({
        error: metaMsg,
        detalhe: upload
      }, 400);
    }

    return c.json({
      sucesso: true,
      video_id: upload.id,
      videoId: upload.id,
      video_nome: nomeInformado,
      video_tipo: video.type || "",
      video_tamanho: video.size || 0
    });

  } catch (err: any) {

    console.error("UPLOAD VIDEO:", err?.message || err);

    return c.json({
      error: err?.message || "Erro upload vídeo"
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
      daily_budget,
      imageHash,
      imageHashes,
      imageUrls,
      video_id,
      videoId,
      video_url,
      videoUrl
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

    const videoMetaId =
      textoOpcional(video_id) ||
      textoOpcional(videoId) ||
      textoOpcional(avancadas.video_id) ||
      textoOpcional(avancadas.videoId);

    const videoMetaUrl =
      textoOpcional(video_url) ||
      textoOpcional(videoUrl) ||
      textoOpcional(avancadas.video_url) ||
      textoOpcional(avancadas.videoUrl);

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
        description: descricaoAnuncio,
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

    // 🔥 INSTAGRAM ACTOR (necessario para o anuncio veicular no Instagram)
    const plataformasSelecionadas: string[] =
      Array.isArray(avancadas?.plataformas)
        ? avancadas.plataformas
        : [];

    let instagramActorId: string | null = null;

    if (plataformasSelecionadas.includes("instagram")) {

      instagramActorId =
        textoOpcional(avancadas.instagram_actor_id);

      if (!instagramActorId) {
        const contasInstagramAnuncio =
          await listarContasInstagramAnuncio(token, adAccountId);

        instagramActorId =
          contasInstagramAnuncio[0]?.id || null;
      }
    }

    const objectStorySpec: Record<string, any> = videoMetaId
      ? {
          page_id,
          video_data: {
            video_id: videoMetaId,
            title: tituloAnuncio,
            message: texto || "Quer mais clientes? 🚀",
            call_to_action: {
              type: ctaType,
              value: { lead_gen_form_id: form_id }
            }
          }
        }
      : {
          page_id,
          link_data: linkDataBase
        };

    if (instagramActorId) {
      objectStorySpec.instagram_actor_id = instagramActorId;
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

          object_story_spec: objectStorySpec,

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

      const metaMsgCreativo =
        creative?.error?.error_user_msg ||
        creative?.error?.message ||
        null;

      return c.json({
        error: metaMsgCreativo || "Erro ao criar criativo",
        codigo_meta: creative?.error?.code ?? null,
        detalhe: creative.error || creative
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
    const configuracoesPersistidas = {
      ...(configuracoes_avancadas || {}),
      texto,
      cta,
      page_id,
      form_id,
      imageHash: hashes[0] || imageHash || null,
      imageHashes: hashes,
      imagens_urls: Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [],
      image_urls: Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [],
      video_id: videoMetaId || null,
      videoId: videoMetaId || null,
      video_url: videoMetaUrl || null,
      videoUrl: videoMetaUrl || null,
      creative_id: creative.id,
      ad_id: ad.id,
      adset_id,
      image_hash: hashes[0] || imageHash || null,
      image_hashes: hashes,
      criativo: {
        creative_id: creative.id,
        image_hash: hashes[0] || imageHash || null,
        image_hashes: hashes,
        video_id: videoMetaId || null,
        video_url: videoMetaUrl || null,
        carrossel: isCarrossel,
        tipo: videoMetaId ? "video" : isCarrossel ? "carrossel" : "imagem",
        titulo: tituloAnuncio,
        descricao: descricaoAnuncio,
        link: linkDestino
      }
    };

    const update = await client.query(
      `
      UPDATE campanhas
      SET
        adset_id = $1,
        ad_id = $2,
        form_id = $3,
        page_id = $4,
        daily_budget = $5,
        configuracoes_avancadas = COALESCE(configuracoes_avancadas, '{}'::jsonb) || $6::jsonb
      WHERE CAST(campaign_id AS TEXT) = $7
      AND usuario_id = $8
      `,
      [
        adset_id,
        ad.id,
        form_id,
        page_id,
        numeroOpcional(daily_budget),
        JSON.stringify(configuracoesPersistidas),
        String(campaign_id),
        usuarioId
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
      SELECT access_token, ultimo_sync, conta_anuncios_id,
        instagram_id, instagram_username, instagram_profile_picture_url
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

    // 🔥 PÁGINAS COM TERMOS DE LEAD ADS JÁ ACEITOS
    const tosAceitos = await client.query(
      "SELECT page_id FROM meta_tos_aceites WHERE usuario_id = $1",
      [usuario_id]
    );

    const tosAceitas =
      tosAceitos.rows.map((linha: any) => linha.page_id);

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

      console.log(
        "META PAGINAS + INSTAGRAM (sem conta selecionada):",
        JSON.stringify(
          paginasSemConta.map((p: any) => ({
            id: p.id,
            name: p.name,
            instagram: p.instagram
          }))
        )
      );

      const instagramSemConta =
        (await detectarInstagramMeta(token, paginasSemConta)) ||
        (conn.rows[0].instagram_id ? {
          id: conn.rows[0].instagram_id,
          username: conn.rows[0].instagram_username,
          profile_picture_url: conn.rows[0].instagram_profile_picture_url
        } : null);

      if (instagramSemConta) {
        for (const pagina of paginasSemConta) {
          if (!pagina.instagram) {
            pagina.instagram = instagramSemConta;
          }
        }
      }

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
        tos_aceitas: tosAceitas,
        instagram: instagramSemConta,
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

    console.log(
      "META PAGINAS + INSTAGRAM:",
      JSON.stringify(
        paginas.map((p: any) => ({
          id: p.id,
          name: p.name,
          instagram: p.instagram
        }))
      )
    );

    // 🔥 DIAGNÓSTICO: permissões realmente concedidas pelo usuário
    try {
      const permsRes = await fetch(
        `https://graph.facebook.com/v19.0/me/permissions?access_token=${token}`
      ).then(r => r.json());

      console.log("META PERMISSOES:", JSON.stringify(permsRes));
    } catch (e) {
      console.error("ERRO PERMISSOES META:", e);
    }

    // 🔥 INSTAGRAM
    const instagram =
      (await detectarInstagramMeta(token, paginas)) ||
      (conn.rows[0].instagram_id ? {
        id: conn.rows[0].instagram_id,
        username: conn.rows[0].instagram_username,
        profile_picture_url: conn.rows[0].instagram_profile_picture_url
      } : null);

    // Reflete o vinculo encontrado (qualquer origem) nas Paginas, para o front-end
    if (instagram) {
      for (const pagina of paginas) {
        if (!pagina.instagram) {
          pagina.instagram = instagram;
        }
      }
    }

    // 🔥 INSTAGRAM VINCULADO AO GERENCIADOR DE NEGOCIOS DA CONTA DE ANUNCIOS
    // (permite anunciar no Instagram mesmo sem vinculo direto com a Pagina)
    const contasInstagramAnuncio =
      await listarContasInstagramAnuncio(token, adAccountId);

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

    // 3=UNSETTLED, 8=PENDING_SETTLEMENT, 9=IN_GRACE_PERIOD
    const pendenciaPagamento =
      [3, 8, 9].includes(Number(conta.account_status));

    const pagamentoAutomatico =
      Boolean(conta.funding_source);

    const pagamentoManual =
      conta.is_prepay_account === true;

    const saldoApi =
      normalizarValorMonetarioMeta(
        conta.balance,
        conta.currency
      );

    const saldoDisplayString =
      conta.funding_source_details?.display_string ?? null;

    console.log("[saldo-meta]", {
      balance_bruto: conta.balance,
      display_string: saldoDisplayString,
      currency: conta.currency,
      account_status: conta.account_status,
      is_prepay: conta.is_prepay_account,
    });

    const saldoPrePago = extrairSaldoDisponivelMeta(saldoDisplayString);

    const saldoManual =
      saldoPrePago !== null
        ? saldoPrePago
        : saldoApi;

    const saldoPrePagoZerado =
      pagamentoManual &&
      saldoManual !== null &&
      saldoManual <= 0;

    const pagamentoHabilitado =
      pagamentoAutomatico ||
      (pagamentoManual && !saldoPrePagoZerado);

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
            ? saldoManual
            : saldoApi,
        saldo_pre_pago: saldoPrePago,
        saldo_pendente_api: saldoApi,
        saldo_bruto_api: conta.balance ?? null,
        saldo_display_string: saldoDisplayString,
        saldo_origem:
          pagamentoManual && saldoPrePago !== null
            ? "saldo_pre_pago"
            : saldoApi !== null
            ? "balance"
            : null,
        saldo_observacao:
          pagamentoManual && saldoPrePago === null && saldoApi !== null
            ? "A Meta nao informou o saldo pre-pago detalhado, entao exibimos o saldo retornado pela API."
            : pagamentoManual && saldoManual === null
            ? "A Meta nao confirmou o saldo pela API. Confira o saldo diretamente no Gerenciador de Anuncios."
            : null,
        pre_pago: pagamentoManual,
        ativa: contaAtiva,
        tipo_pagamento: tipoPagamento,
        pagamento_automatico: pagamentoAutomatico,
        pagamento_manual: pagamentoManual,
        pagamento_habilitado: pagamentoHabilitado,
        possui_pagamento: pagamentoHabilitado,
        saldo_zerado: saldoPrePagoZerado,
        pendencia_pagamento: pendenciaPagamento,
        erro_pagamento: pendenciaPagamento
          ? "Sua conta tem uma pendência financeira registrada na Meta — isso pode acontecer mesmo com saldo disponível, quando a Meta tentou cobrar um método automático e a cobrança falhou. Para resolver: acesse o Gerenciador de Anúncios > Faturamento, verifique se há cobranças em aberto e confirme ou atualize o método de pagamento."
          : saldoPrePagoZerado
          ? "Saldo pré-pago zerado na conta de anúncios. Para resolver: acesse o Gerenciador de Anúncios > Faturamento, clique em 'Adicionar saldo' e insira um valor para os anúncios voltarem a veicular."
          : null
      },

      contas_anuncios: contasAds.map((conta: any) => ({
        id: conta.id,
        nome: conta.name,
        status: conta.account_status,
        moeda: conta.currency || null
      })),

      paginas,

      tos_aceitas: tosAceitas,

      instagram,

      contas_instagram_anuncio: contasInstagramAnuncio.map((conta: any) => ({
        id: conta.id,
        username: conta.username || null,
        profile_picture_url: conta.profile_picture_url || null
      })),

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

app.post("/meta/tos-aceitar", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    const { page_id, usuario_id } = await c.req.json();

    const usuarioId =
      resolverUsuarioIdOperacao(user, usuario_id);

    if (!usuarioId) {
      return negarAcessoConta(c);
    }

    if (!page_id) {
      return c.json({ error: "page_id obrigatório" }, 400);
    }

    await client.query(
      `
      INSERT INTO meta_tos_aceites (usuario_id, page_id)
      VALUES ($1, $2)
      ON CONFLICT (usuario_id, page_id) DO NOTHING
      `,
      [usuarioId, page_id]
    );

    return c.json({ sucesso: true });

  } catch (err) {

    console.error(
      "ERRO TOS ACEITAR:",
      err
    );

    return c.json({
      error: "Erro ao registrar aceite dos termos"
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

app.post("/meta/direcionamento/localizacao", authMiddleware, async (c) => {
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
        error: "Conecte a Meta antes de buscar localizações"
      }, 400);
    }

    const params =
      new URLSearchParams({
        type: "adgeolocation",
        q: termo,
        location_types: JSON.stringify([
          "country",
          "region",
          "city",
          "neighborhood",
          "geo_market",
          "zip"
        ]),
        limit: "10",
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
          "Erro ao buscar localizações na Meta",
        detalhe: resposta.error
      }, 400);
    }

    return c.json({
      data: Array.isArray(resposta.data)
        ? resposta.data
            .map((local: any) => ({
              key: textoOpcional(local.key),
              nome: textoOpcional(local.name),
              tipo: textoOpcional(local.type),
              regiao: textoOpcional(local.region),
              pais: textoOpcional(local.country_name)
            }))
            .filter((local: any) =>
              local.key &&
              local.nome &&
              local.tipo
            )
        : []
    });
  } catch (err) {
    console.error("ERRO BUSCA LOCALIZACAO:", err);

    return c.json({
      error: "Erro ao buscar localização Meta"
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


// =============================================
//   🔌 HUB DE CONEXÕES — multi-plataforma
// =============================================

const PLATAFORMAS_DISPONIVEIS = [
  "meta",
  "google",
  "tiktok",
  "linkedin",
  "kwai",
  "pinterest",
  "snapchat",
  "microsoft",
  "formulario",
] as const;

app.get("/conexoes", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");

    // Meta: usa tabela legada meta_conexoes (nao tem coluna conectado_em, usa criado_em)
    const metaConn = await client.query(
      `SELECT conta_anuncios_id, instagram_username, criado_em AS conectado_em
       FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1`,
      [user.id]
    );

    // Demais plataformas
    const outrasConn = await client.query(
      `SELECT plataforma, status, dados_conta, conectado_em
       FROM plataforma_conexoes WHERE usuario_id = $1`,
      [user.id]
    );

    const mapaOutras = new Map(
      outrasConn.rows.map((r: any) => [r.plataforma, r])
    );

    const conexoes = PLATAFORMAS_DISPONIVEIS.map((plataforma) => {
      if (plataforma === "formulario") {
        return { plataforma, status: "conectado", conta: null, conectado_em: null };
      }
      if (plataforma === "meta") {
        const m = metaConn.rows[0];
        return {
          plataforma,
          status: m ? "conectado" : "desconectado",
          conta: m
            ? { conta_anuncios_id: m.conta_anuncios_id, instagram_username: m.instagram_username }
            : null,
          conectado_em: m?.conectado_em ?? null,
        };
      }
      const r = mapaOutras.get(plataforma);
      return {
        plataforma,
        status: r?.status ?? "desconectado",
        conta: r?.dados_conta ?? null,
        conectado_em: r?.conectado_em ?? null,
      };
    });

    return c.json({ conexoes });
  } catch (err) {
    console.error("ERRO GET /conexoes:", err);
    return c.json({ error: "Erro ao listar conexoes" }, 500);
  }
});

app.delete("/conexoes/:plataforma", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const plataforma = c.req.param("plataforma");

    if (!PLATAFORMAS_DISPONIVEIS.includes(plataforma as any)) {
      return c.json({ error: "Plataforma invalida" }, 400);
    }

    if (plataforma === "formulario") {
      return c.json({ error: "Formulario proprio nao pode ser desconectado" }, 400);
    }

    if (plataforma === "meta") {
      // Revoga token na Meta e remove da tabela legada
      const conn = await client.query(
        `SELECT access_token FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1`,
        [user.id]
      );
      const token = conn.rows[0]?.access_token;
      if (token) {
        await fetch(`https://graph.facebook.com/v19.0/me/permissions?access_token=${token}`, {
          method: "DELETE",
        }).catch(() => {});
      }
      await client.query(`DELETE FROM meta_conexoes WHERE usuario_id = $1`, [user.id]);
    } else {
      await client.query(
        `DELETE FROM plataforma_conexoes WHERE usuario_id = $1 AND plataforma = $2`,
        [user.id, plataforma]
      );
    }

    return c.json({ sucesso: true });
  } catch (err) {
    console.error("ERRO DELETE /conexoes:", err);
    return c.json({ error: "Erro ao desconectar plataforma" }, 500);
  }
});

/* =========================
   🎵 WEBHOOK TIKTOK — leads em tempo real
========================= */

// TikTok envia GET para verificação do endpoint (challenge)
app.get("/webhook/tiktok", async (c) => {
  const challenge = c.req.query("challenge");
  if (challenge) return c.text(challenge);
  return c.text("TikTok webhook ativo");
});

app.post("/webhook/tiktok", async (c) => {
  try {
    const body = await c.req.json() as any;
    console.log("WEBHOOK TIKTOK RECEBIDO:", JSON.stringify(body));

    // TikTok envia um array de eventos em data
    const eventos = Array.isArray(body) ? body : [body];

    for (const evento of eventos) {
      if (evento.event_type !== "LEAD_GENERATION_NEW_LEAD") continue;

      const advertiserId = String(evento.advertiser_id ?? "");
      const leadId       = String(evento.lead_id ?? "");
      const formId       = String(evento.form_id ?? "");

      if (!leadId || !advertiserId) continue;

      // Identifica o usuário pela conta de anunciante
      const conn = await client.query(
        `SELECT usuario_id, access_token
         FROM plataforma_conexoes
         WHERE plataforma = 'tiktok'
           AND dados_conta->>'advertiser_id' = $1
         LIMIT 1`,
        [advertiserId]
      );
      if (!conn.rows.length) {
        console.log("TikTok webhook: anunciante nao identificado:", advertiserId);
        continue;
      }

      const usuarioId = Number(conn.rows[0].usuario_id);
      const token     = conn.rows[0].access_token;

      const jaExiste = await client.query(
        `SELECT id FROM leads WHERE lead_id = $1 AND usuario_id = $2`,
        [leadId, usuarioId]
      );
      if (jaExiste.rows.length > 0) continue;

      // Busca os dados completos do lead
      const leadRes = await fetch(
        `${TIKTOK_API}/lead/get/?advertiser_id=${advertiserId}&lead_id=${leadId}`,
        { headers: tiktokHeaders(token) }
      );
      const leadData = await leadRes.json() as any;

      if (leadData.code !== 0 || !leadData.data?.list?.length) {
        console.error("TIKTOK WEBHOOK: erro ao buscar lead:", leadData);
        continue;
      }

      const lead = leadData.data.list[0];

      let nomeCampanha = "Campanha TikTok";
      let nichoId: number | null = null;
      if (formId) {
        const campRow = await client.query(
          `SELECT nome, nicho_id FROM campanhas WHERE form_id = $1 AND usuario_id = $2 LIMIT 1`,
          [formId, usuarioId]
        );
        if (campRow.rows.length) {
          nomeCampanha = campRow.rows[0].nome;
          nichoId = campRow.rows[0].nicho_id ?? null;
        }
      }

      let nome = "";
      let email = "";
      let telefone = "";
      const respostasQualificacao: any[] = [];

      for (const field of lead.fields ?? []) {
        const key = (field.name ?? "").toUpperCase();
        if (key === "FULL_NAME" || key === "FIRST_NAME") nome = field.value ?? "";
        else if (key === "EMAIL") email = field.value ?? "";
        else if (key === "PHONE_NUMBER") telefone = field.value ?? "";
        else respostasQualificacao.push({ pergunta: field.name, resposta: field.value ?? "" });
      }

      const criadoEm = lead.submit_time
        ? new Date(Number(lead.submit_time) * 1000).toISOString()
        : null;

      await client.query(
        `INSERT INTO leads
           (usuario_id, lead_id, nome, email, telefone, campanha, conta_anuncios_id,
            origem, plataforma, status, respostas_qualificacao, nicho_id, criado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'tiktok','tiktok','novo',$8,$9,COALESCE($10::timestamptz, NOW()))`,
        [
          usuarioId, leadId, nome || "Lead TikTok", email, telefone,
          nomeCampanha, advertiserId,
          JSON.stringify(respostasQualificacao), nichoId, criadoEm
        ]
      );

      console.log("✅ TIKTOK LEAD SALVO:", leadId, "usuario:", usuarioId);
      await notificarNovoLeadWhatsApp(usuarioId, { nome, telefone, email, campanha: nomeCampanha });
    }

    return c.json({ sucesso: true });
  } catch (err) {
    console.error("ERRO WEBHOOK TIKTOK:", err);
    return c.json({ error: "Erro webhook TikTok" }, 500);
  }
});

// 🔥 WEBHOOK Z-API — eventos de conexão/desconexão
app.post("/webhook/zapi", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const tipo = body?.type || body?.event || "";

    if (tipo === "DisconnectedCallback" || tipo === "disconnected") {
      console.warn("[z-api webhook] instância desconectada — enviando alerta por e-mail");

      const adminEmail = Bun.env.PLATAFORMA_CONTATO_EMAIL || "pereira.notlim@gmail.com";
      const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

      if (Bun.env.RESEND_API_KEY) {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${Bun.env.RESEND_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: PLATAFORMA_FROM_EMAIL,
            to: adminEmail,
            subject: "⚠️ WhatsApp desconectado — Plataforma de Leads",
            text: `Atenção!\n\nSua instância Z-API (WhatsApp) foi desconectada em ${agora}.\n\nAs notificações de novos leads estão pausadas até você reconectar.\n\nAcesse https://app.z-api.io e reconecte sua instância.\n\nPlataforma de Leads`
          })
        }).catch((e: any) => console.error("[z-api webhook] erro ao enviar e-mail:", e));
      }
    }

    return c.json({ ok: true });
  } catch (e) {
    console.error("[z-api webhook] erro:", e);
    return c.json({ ok: true }); // sempre retorna 200 para o Z-API não retentar
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
            let nichoIdLead: number | null = null;

            if (form_id) {
              const campanhaByForm = await client.query(
                `
                SELECT usuario_id, nome, conta_anuncios_id, nicho_id
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
                nichoIdLead = campanhaByForm.rows[0].nicho_id ?? null;
              }
            }

            if (!usuarioId && page_id) {
              const campanhaByPage = await client.query(
                `
                SELECT usuario_id, nome, conta_anuncios_id, nicho_id
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
                nichoIdLead = campanhaByPage.rows[0].nicho_id ?? null;
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
              `
              SELECT id
              FROM leads
              WHERE lead_id = $1
              AND usuario_id = $2
              `,
              [leadgen_id, usuarioId]
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
                nicho_id,
                criado_em
              )
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::timestamptz, NOW()))
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
                nichoIdLead,
                criadoEmMeta
              ]
            );

            console.log(
              "✅ LEAD SALVO:",
              leadgen_id,
              "usuário:",
              usuarioId
            );

            // 📲 notificação WhatsApp para o dono da campanha
            await notificarNovoLeadWhatsApp(usuarioId, { nome, telefone, email, campanha: nomeCampanha });
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
  CREATE TABLE IF NOT EXISTS plataforma_oauth_states (
    id SERIAL PRIMARY KEY,
    state_hash TEXT NOT NULL,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    plataforma TEXT NOT NULL,
    expira_em TIMESTAMP NOT NULL,
    usado_em TIMESTAMP,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(state_hash, plataforma)
  );
`);

await client.query(`
  CREATE INDEX IF NOT EXISTS idx_plataforma_oauth_states_hash
  ON plataforma_oauth_states (state_hash);
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS meta_tos_aceites (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL,
    page_id TEXT NOT NULL,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(usuario_id, page_id)
  );
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
    provider TEXT DEFAULT 'openai',
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

await client.query(`
  ALTER TABLE ia_usos ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'openai';
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS ia_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    provedor TEXT DEFAULT 'openai',
    modelo TEXT DEFAULT 'gpt-5-mini',
    anthropic_modelo TEXT DEFAULT 'claude-haiku-4-5-20251001',
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
  ALTER TABLE ia_config ADD COLUMN IF NOT EXISTS anthropic_modelo TEXT DEFAULT 'claude-haiku-4-5-20251001';
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
  ALTER TABLE railway_billing_config
    ADD COLUMN IF NOT EXISTS limite_alerta_usd NUMERIC(10,2) DEFAULT 5.00,
    ADD COLUMN IF NOT EXISTS ultima_notif_custo_data DATE,
    ADD COLUMN IF NOT EXISTS ultima_notif_cobranca_data DATE;
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
    ADD COLUMN IF NOT EXISTS ia_provider TEXT DEFAULT 'auto',
    ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS is_parceiro BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS parceiro_id INTEGER;
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS parceiro_financeiro (
    id SERIAL PRIMARY KEY,
    parceiro_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    cliente_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    mes_referencia DATE NOT NULL,
    plano TEXT,
    valor_mensalidade NUMERIC(12, 2) DEFAULT 0,
    valor_comissao NUMERIC(12, 2) DEFAULT 0,
    status TEXT DEFAULT 'pendente',
    pago_em TIMESTAMP,
    observacoes TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (cliente_id, mes_referencia)
  );
`);

await client.query(`
  ALTER TABLE parceiro_financeiro
    ADD COLUMN IF NOT EXISTS plano TEXT;
`);

await client.query(`
  ALTER TABLE chat_conversas
    ADD COLUMN IF NOT EXISTS suporte_visto_em TIMESTAMP;
`);

await client.query(`
  ALTER TABLE parceiro_financeiro
    ADD COLUMN IF NOT EXISTS percentual_parceiro NUMERIC(5, 2) DEFAULT ${PARCEIRO_PERCENTUAL_COMISSAO * 100};
`);

await client.query(`
  CREATE INDEX IF NOT EXISTS idx_parceiro_financeiro_parceiro
    ON parceiro_financeiro(parceiro_id);
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
    ADD COLUMN IF NOT EXISTS conta_anuncios_id TEXT,
    ADD COLUMN IF NOT EXISTS instagram_id TEXT,
    ADD COLUMN IF NOT EXISTS instagram_username TEXT,
    ADD COLUMN IF NOT EXISTS instagram_profile_picture_url TEXT,
    ADD COLUMN IF NOT EXISTS instagram_token TEXT,
    ADD COLUMN IF NOT EXISTS instagram_conectado_em TIMESTAMP;
`);

await client.query(`
  ALTER TABLE chat_mensagens
    ADD COLUMN IF NOT EXISTS anexo_url TEXT,
    ADD COLUMN IF NOT EXISTS anexo_tipo TEXT,
    ADD COLUMN IF NOT EXISTS anexo_nome TEXT;
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
    ADD COLUMN IF NOT EXISTS encaminhada_em TIMESTAMP,
    ADD COLUMN IF NOT EXISTS daily_budget INTEGER;
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS campanha_corretores (
    campanha_id INTEGER NOT NULL REFERENCES campanhas(id) ON DELETE CASCADE,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    criado_em TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (campanha_id, usuario_id)
  );
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS campanha_corretores_historico (
    campanha_id INTEGER NOT NULL REFERENCES campanhas(id) ON DELETE CASCADE,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'enviado',
    atualizado_em TIMESTAMP DEFAULT NOW(),
    enviado_por_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    PRIMARY KEY (campanha_id, usuario_id)
  );
`);

await client.query(`
  ALTER TABLE campanha_corretores_historico
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'enviado',
    ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS enviado_por_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;
`);

await client.query(`
  INSERT INTO campanha_corretores (campanha_id, usuario_id)
  SELECT id, encaminhada_para_usuario_id
  FROM campanhas
  WHERE encaminhada_para_usuario_id IS NOT NULL
  ON CONFLICT DO NOTHING;
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
  CREATE INDEX IF NOT EXISTS idx_campanha_corretores_usuario
    ON campanha_corretores(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_campanha_corretores_historico_usuario
    ON campanha_corretores_historico(usuario_id);
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

await client.query(`
  CREATE TABLE IF NOT EXISTS nichos (
    id SERIAL PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    nome TEXT NOT NULL,
    cor TEXT NOT NULL
  );
`);

await client.query(`
  INSERT INTO nichos (slug, nome, cor) VALUES
    ('imoveis',     'Imóveis',          '#2563EB'),
    ('saude',       'Planos de Saúde',  '#DC2626'),
    ('suplementos', 'Suplementos',      '#EA580C'),
    ('saas',        'Plataforma / SaaS','#7C3AED')
  ON CONFLICT (slug) DO UPDATE SET cor = EXCLUDED.cor, nome = EXCLUDED.nome;
`);

await client.query(`UPDATE nichos SET cor = '#DC2626', nome = 'Planos de Saúde' WHERE slug = 'saude';`);

await client.query(`
  CREATE TABLE IF NOT EXISTS usuario_nichos (
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    nicho_id   INTEGER NOT NULL REFERENCES nichos(id)   ON DELETE CASCADE,
    criado_em  TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (usuario_id, nicho_id)
  );
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS campanhas_imoveis (
    campanha_id INTEGER PRIMARY KEY REFERENCES campanhas(id) ON DELETE CASCADE,
    tipo_imovel TEXT,
    finalidade  TEXT,
    valor_min   NUMERIC(12, 2),
    valor_max   NUMERIC(12, 2),
    regiao      TEXT
  );
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS campanhas_saude (
    campanha_id      INTEGER PRIMARY KEY REFERENCES campanhas(id) ON DELETE CASCADE,
    operadora        TEXT,
    tipo_plano       TEXT,
    faixa_etaria_min INTEGER,
    faixa_etaria_max INTEGER,
    cobertura        TEXT,
    acomodacao       TEXT
  );
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS campanhas_suplementos (
    campanha_id  INTEGER PRIMARY KEY REFERENCES campanhas(id) ON DELETE CASCADE,
    produto      TEXT,
    objetivo     TEXT,
    marca        TEXT,
    publico_alvo TEXT
  );
`);

await client.query(`
  ALTER TABLE campanhas
    ADD COLUMN IF NOT EXISTS nicho_id INTEGER REFERENCES nichos(id);
`);

await client.query(`
  ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS nicho_id INTEGER REFERENCES nichos(id);
`);

await client.query(`
  CREATE INDEX IF NOT EXISTS idx_campanhas_nicho_id
    ON campanhas(nicho_id);
  CREATE INDEX IF NOT EXISTS idx_leads_nicho_id
    ON leads(nicho_id);
  CREATE INDEX IF NOT EXISTS idx_usuario_nichos_usuario
    ON usuario_nichos(usuario_id);
`);

await client.query(`
  ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(20);
`);

await client.query(`
  ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS notif_whatsapp_lead BOOLEAN DEFAULT TRUE;
`);

await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS data_contato DATE;`);
await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS lembrete_1dia_enviado BOOLEAN DEFAULT FALSE;`);
await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS lembrete_dia_enviado BOOLEAN DEFAULT FALSE;`);
await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS observacao_agendamento TEXT;`);

await client.query(`
  CREATE TABLE IF NOT EXISTS notificacoes (
    id           SERIAL PRIMARY KEY,
    usuario_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    lead_id      INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    tipo         VARCHAR(50) NOT NULL DEFAULT 'lembrete_contato',
    titulo       TEXT NOT NULL,
    mensagem     TEXT NOT NULL,
    lido         BOOLEAN DEFAULT FALSE,
    criado_em    TIMESTAMP DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_notificacoes_usuario
    ON notificacoes(usuario_id, lido, criado_em DESC);
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS campanhas_rascunho (
    id           SERIAL PRIMARY KEY,
    criador_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    corretor_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    nome         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pendente'
                   CHECK (status IN ('pendente', 'ativado', 'rejeitado', 'cancelado')),
    configuracoes JSONB NOT NULL DEFAULT '{}',
    motivo_rejeicao TEXT,
    criado_em    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ativado_em   TIMESTAMP,
    campanha_id  INTEGER REFERENCES campanhas(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_campanhas_rascunho_criador
    ON campanhas_rascunho(criador_id);
  CREATE INDEX IF NOT EXISTS idx_campanhas_rascunho_corretor
    ON campanhas_rascunho(corretor_id, status);
`);

await client.query(`
  CREATE TABLE IF NOT EXISTS plataforma_conexoes (
    id               SERIAL PRIMARY KEY,
    usuario_id       INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    plataforma       TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'conectado'
                       CHECK (status IN ('conectado', 'desconectado', 'erro')),
    access_token     TEXT,
    refresh_token    TEXT,
    token_expira_em  TIMESTAMP,
    dados_conta      JSONB,
    conectado_em     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(usuario_id, plataforma)
  );
  CREATE INDEX IF NOT EXISTS idx_plataforma_conexoes_usuario
    ON plataforma_conexoes(usuario_id);
`);

await client.query(`
  ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS plataforma TEXT DEFAULT 'meta',
    ADD COLUMN IF NOT EXISTS campanha_id INTEGER REFERENCES campanhas(id) ON DELETE SET NULL;
`);

await client.query(`
  ALTER TABLE campanhas
    ADD COLUMN IF NOT EXISTS plataforma TEXT DEFAULT 'meta';
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
        ? "Não foi possível enviar o email de troca de senha. Verifique PLATAFORMA_FROM_EMAIL e o domínio no Resend."
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

// 🔹 perfil do usuário autenticado
app.get("/usuarios/me", authMiddleware, async (c) => {
  const user: any = c.get("user");
  return c.json({
    id:                   user.id,
    email:                user.email,
    nome:                 user.nome,
    sobrenome:            user.sobrenome,
    whatsapp:             user.whatsapp || null,
    notif_whatsapp_lead:  user.notif_whatsapp_lead !== false,
    tipo:                 user.tipo
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


// 🔹 atualizar WhatsApp do usuário autenticado
app.patch("/usuarios/me/whatsapp", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const { whatsapp } = await c.req.json();
    const numero = String(whatsapp || "").replace(/\D/g, "").slice(0, 20) || null;
    await client.query(
      `UPDATE usuarios SET whatsapp = $1 WHERE id = $2`,
      [numero, user.id]
    );
    return c.json({ ok: true, whatsapp: numero });
  } catch (err) {
    console.error("ERRO WHATSAPP:", err);
    return c.json({ error: "Erro ao salvar WhatsApp" }, 500);
  }
});

// 🔹 ligar/desligar notificação WhatsApp de novo lead
app.patch("/usuarios/me/notif-whatsapp-lead", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const { ativo } = await c.req.json();
    await client.query(
      `UPDATE usuarios SET notif_whatsapp_lead = $1 WHERE id = $2`,
      [ativo !== false, user.id]
    );
    return c.json({ ok: true, notif_whatsapp_lead: ativo !== false });
  } catch (err) {
    console.error("ERRO NOTIF WHATSAPP LEAD:", err);
    return c.json({ error: "Erro ao atualizar preferência" }, 500);
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

    const nichoSlug =
      textoOpcional(c.req.query("nicho"));

    const campanhas = await client.query(
      `
      SELECT
        c.*,
        COALESCE(n.id,   nd.id)   AS nicho_id,
        COALESCE(n.slug, nd.slug) AS nicho_slug,
        COALESCE(n.nome, nd.nome) AS nicho_nome,
        COALESCE(n.cor,  nd.cor)  AS nicho_cor,
        dono.email     AS criado_por_email,
        dono.nome      AS criado_por_nome,
        dono.sobrenome AS criado_por_sobrenome,
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'id', cor.id,
              'nome', cor.nome,
              'sobrenome', cor.sobrenome,
              'email', cor.email
            ))
            FROM campanha_corretores cc
            INNER JOIN usuarios cor
              ON cor.id = cc.usuario_id
            WHERE cc.campanha_id = c.id
          ),
          '[]'
        ) AS corretores_encaminhados,
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'id', cor.id,
              'nome', cor.nome,
              'sobrenome', cor.sobrenome,
              'email', cor.email,
              'status', ch.status,
              'atualizado_em', ch.atualizado_em
            ) ORDER BY ch.atualizado_em DESC)
            FROM campanha_corretores_historico ch
            INNER JOIN usuarios cor
              ON cor.id = ch.usuario_id
            WHERE ch.campanha_id = c.id
          ),
          '[]'
        ) AS corretores_envio_historico
      FROM campanhas c
      INNER JOIN usuarios dono
        ON dono.id = c.usuario_id
      LEFT JOIN nichos n
        ON n.id = c.nicho_id
      LEFT JOIN LATERAL (
        SELECT ni.id, ni.slug, ni.nome, ni.cor
        FROM nichos ni
        WHERE c.nicho_id IS NULL AND (
          EXISTS (SELECT 1 FROM campanhas_saude      cs WHERE cs.campanha_id = c.id) AND ni.slug = 'saude'
          OR
          EXISTS (SELECT 1 FROM campanhas_imoveis    ci WHERE ci.campanha_id = c.id) AND ni.slug = 'imoveis'
          OR
          EXISTS (SELECT 1 FROM campanhas_suplementos cp WHERE cp.campanha_id = c.id) AND ni.slug = 'suplementos'
          OR
          EXISTS (SELECT 1 FROM leads l WHERE l.campanha = c.nome AND l.nicho_id = ni.id AND l.usuario_id = c.usuario_id LIMIT 1)
        )
        LIMIT 1
      ) nd ON true
      WHERE
        (
          c.usuario_id = $1
          OR EXISTS (
            SELECT 1
            FROM campanha_corretores cc2
            WHERE cc2.campanha_id = c.id
            AND cc2.usuario_id = $1
          )
        )
        AND (
          c.origem = 'manual'
          OR c.conta_anuncios_id = $2
        )
        AND ($3::text IS NULL OR n.slug = $3)
      ORDER BY c.id DESC
      `,
      [user.id, contaAnunciosId ?? null, nichoSlug ?? null]
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
      user.tipo !== "super_admin" &&
      user.tipo !== "criador_campanha"
    ) {
      return c.json({
        error: "Apenas administradores podem encaminhar campanhas"
      }, 403);
    }

    const campanhaId =
      Number(c.req.param("id"));

    const body =
      await c.req.json();

    const corretorIds: number[] = Array.isArray(body.corretor_ids)
      ? Array.from(new Set<number>(
          body.corretor_ids
            .map((id: any) => Number(id))
            .filter((id: number) => Number.isFinite(id))
        ))
      : body.corretor_id
        ? [Number(body.corretor_id)]
        : [];

    const usuarioEnviaSemVinculo =
      user.tipo === "super_admin" ||
      user.tipo === "criador_campanha";

    const usuarioPodeEnviarCampanhaDeQualquerDono =
      user.tipo === "super_admin";

    const campanha = await client.query(
      `
      SELECT id
      FROM campanhas
      WHERE id = $1
      AND (
        usuario_id = $2
        OR $3::boolean = true
      )
      LIMIT 1
      `,
      [campanhaId, user.id, usuarioPodeEnviarCampanhaDeQualquerDono]
    );

    if (!campanha.rows.length) {
      return c.json({
        error: usuarioEnviaSemVinculo
          ? "Campanha não encontrada"
          : "Campanha não encontrada para este Admin Corretor"
      }, 404);
    }

    if (corretorIds.length) {

      const corretores =
        !usuarioEnviaSemVinculo
          ? await client.query(
              `
              SELECT id
              FROM usuarios
              WHERE id = ANY($1::int[])
              AND admin_id = $2
              AND tipo = 'corretor'
              AND COALESCE(ativo, true) = true
              `,
              [corretorIds, user.id]
            )
          : await client.query(
              `
              SELECT id
              FROM usuarios
              WHERE id = ANY($1::int[])
              AND tipo NOT IN ('suporte', 'super_admin', 'master')
              AND COALESCE(ativo, true) = true
              `,
              [corretorIds]
            );

      if (corretores.rows.length !== corretorIds.length) {
        return c.json({
          error: usuarioEnviaSemVinculo
            ? "Selecione apenas usuários ativos"
            : "Selecione apenas corretores vinculados e ativos"
        }, 400);
      }
    }

    const conn = await client.connect();

    try {

      await conn.query("BEGIN");

      const corretoresAtivosAntes = await conn.query(
        `
        SELECT usuario_id
        FROM campanha_corretores
        WHERE campanha_id = $1
        `,
        [campanhaId]
      );

      const idsAtivosAntes = corretoresAtivosAntes.rows
        .map((row: any) => Number(row.usuario_id))
        .filter((id: number) => Number.isFinite(id));

      const idsSelecionados = new Set(corretorIds);
      const idsCancelados = idsAtivosAntes.filter(
        (id: number) => !idsSelecionados.has(id)
      );

      await conn.query(
        `
        DELETE FROM campanha_corretores
        WHERE campanha_id = $1
        `,
        [campanhaId]
      );

      for (const corretorId of corretorIds) {
        await conn.query(
          `
          INSERT INTO campanha_corretores (campanha_id, usuario_id)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
          `,
          [campanhaId, corretorId]
        );

        await conn.query(
          `
          INSERT INTO campanha_corretores_historico (
            campanha_id,
            usuario_id,
            status,
            atualizado_em,
            enviado_por_usuario_id
          )
          VALUES ($1, $2, 'enviado', NOW(), $3)
          ON CONFLICT (campanha_id, usuario_id)
          DO UPDATE SET
            status = 'enviado',
            atualizado_em = NOW(),
            enviado_por_usuario_id = EXCLUDED.enviado_por_usuario_id
          `,
          [campanhaId, corretorId, user.id]
        );
      }

      if (idsCancelados.length) {
        await conn.query(
          `
          INSERT INTO campanha_corretores_historico (
            campanha_id,
            usuario_id,
            status,
            atualizado_em,
            enviado_por_usuario_id
          )
          SELECT $1, UNNEST($2::int[]), 'cancelado', NOW(), $3
          ON CONFLICT (campanha_id, usuario_id)
          DO UPDATE SET
            status = 'cancelado',
            atualizado_em = NOW(),
            enviado_por_usuario_id = EXCLUDED.enviado_por_usuario_id
          `,
          [campanhaId, idsCancelados, user.id]
        );
      }

      await conn.query(
        `
        UPDATE campanhas
        SET
          encaminhada_para_usuario_id = NULL,
          encaminhada_em = CASE
            WHEN $1::int > 0 THEN NOW()
            ELSE NULL
          END
        WHERE id = $2
        `,
        [corretorIds.length, campanhaId]
      );

      await conn.query("COMMIT");

    } catch (err) {
      await conn.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      conn.release();
    }

    return c.json({
      sucesso: true,
      campanha: {
        id: campanhaId,
        corretor_ids: corretorIds
      }
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
        ci.tipo_imovel,
        ci.finalidade,
        ci.valor_min,
        ci.valor_max,
        ci.regiao,
        cs.operadora,
        cs.tipo_plano,
        cs.faixa_etaria_min,
        cs.faixa_etaria_max,
        cs.cobertura,
        cs.acomodacao,
        cp.produto,
        cp.objetivo AS objetivo_nicho,
        cp.marca,
        cp.publico_alvo,
        dono.email AS criado_por_email,
        dono.nome AS criado_por_nome,
        dono.sobrenome AS criado_por_sobrenome,
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'id', cor.id,
              'nome', cor.nome,
              'sobrenome', cor.sobrenome,
              'email', cor.email
            ))
            FROM campanha_corretores cc
            INNER JOIN usuarios cor
              ON cor.id = cc.usuario_id
            WHERE cc.campanha_id = c.id
          ),
          '[]'
        ) AS corretores_encaminhados,
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'id', cor.id,
              'nome', cor.nome,
              'sobrenome', cor.sobrenome,
              'email', cor.email,
              'status', ch.status,
              'atualizado_em', ch.atualizado_em
            ) ORDER BY ch.atualizado_em DESC)
            FROM campanha_corretores_historico ch
            INNER JOIN usuarios cor
              ON cor.id = ch.usuario_id
            WHERE ch.campanha_id = c.id
          ),
          '[]'
        ) AS corretores_envio_historico
      FROM campanhas c
      INNER JOIN usuarios dono
        ON dono.id = c.usuario_id
      LEFT JOIN campanhas_imoveis ci
        ON ci.campanha_id = c.id
      LEFT JOIN campanhas_saude cs
        ON cs.campanha_id = c.id
      LEFT JOIN campanhas_suplementos cp
        ON cp.campanha_id = c.id
      WHERE
        (
          c.usuario_id = $1
          OR EXISTS (
            SELECT 1
            FROM campanha_corretores cc2
            WHERE cc2.campanha_id = c.id
            AND cc2.usuario_id = $1
          )
        )
        AND (
          $2::text IS NULL
          OR c.conta_anuncios_id = $2
        )
      ORDER BY c.id DESC
      `,
      [user.id, contaAnunciosId]
    );

    // 🔥 STATUS DA CONTA (account_status indica problema de pagamento/cobranca)
    let erroPagamentoConta: string | null = null;

    if (token && contaAnunciosId) {
      try {
        const contaInfo = await fetch(
          `https://graph.facebook.com/v19.0/${contaAnunciosId}?fields=account_status,disable_reason,balance,is_prepay_account,funding_source,funding_source_details&access_token=${token}`
        ).then(r => r.json());

        console.log("META ACCOUNT STATUS:", JSON.stringify(contaInfo));

        // 3 = UNSETTLED, 8 = PENDING_SETTLEMENT, 9 = IN_GRACE_PERIOD
        if ([3, 8, 9].includes(Number(contaInfo.account_status))) {
          erroPagamentoConta =
            "Sua conta tem uma pendência financeira registrada na Meta — isso pode acontecer mesmo com saldo disponível, quando a Meta tentou cobrar um método automático e a cobrança falhou. Para resolver: acesse o Gerenciador de Anúncios > Faturamento, verifique se há cobranças em aberto e confirme ou atualize o método de pagamento.";
        } else if (!contaInfo.funding_source) {
          erroPagamentoConta =
            "Nenhum método de pagamento configurado na conta de anúncios. Para resolver: acesse o Gerenciador de Anúncios > Faturamento e adicione um cartão de crédito ou saldo pré-pago para ativar as campanhas.";
        } else if (contaInfo.is_prepay_account) {
          // Conta com saldo pré-pago: o saldo real disponível vem na string
          // "Saldo disponível (R$0,00 BRL)" — o campo "balance" não reflete isso.
          const display: string =
            contaInfo.funding_source_details?.display_string || "";

          const match = display.match(/([\d.,]+)\s*[A-Z]{3}\)/);

          if (match) {
            const saldo = Number(
              match[1].replace(/\./g, "").replace(",", ".")
            );

            if (!Number.isNaN(saldo) && saldo <= 0) {
              erroPagamentoConta =
                "Saldo pré-pago zerado na conta de anúncios. Para resolver: acesse o Gerenciador de Anúncios > Faturamento, clique em 'Adicionar saldo' e insira um valor para os anúncios voltarem a veicular.";
            }
          }
        }
      } catch (e) {
        console.error("ERRO STATUS CONTA:", e);
      }
    }

    // 🔥 ISSUES (ex.: erro de pagamento) de todas as campanhas da conta
    const issuesPorCampanha: Record<string, any[]> = {};

    if (token && contaAnunciosId) {
      try {
        const issuesCampResp = await fetch(
          `https://graph.facebook.com/v19.0/${contaAnunciosId}/campaigns?fields=id,issues_info&limit=500&access_token=${token}`
        ).then(r => r.json());

        console.log("META ISSUES CAMPANHAS:", JSON.stringify(issuesCampResp));

        for (const item of issuesCampResp.data || []) {
          if (item.issues_info?.length) {
            issuesPorCampanha[item.id] = [
              ...(issuesPorCampanha[item.id] || []),
              ...item.issues_info
            ];
          }
        }
      } catch (e) {
        console.error("ERRO ISSUES CAMPANHAS:", e);
      }

      try {
        const issuesAdsetResp = await fetch(
          `https://graph.facebook.com/v19.0/${contaAnunciosId}/adsets?fields=id,campaign_id,issues_info,effective_status&limit=500&access_token=${token}`
        ).then(r => r.json());

        console.log("META ISSUES ADSETS:", JSON.stringify(issuesAdsetResp));

        for (const item of issuesAdsetResp.data || []) {
          if (item.issues_info?.length && item.campaign_id) {
            issuesPorCampanha[item.campaign_id] = [
              ...(issuesPorCampanha[item.campaign_id] || []),
              ...item.issues_info
            ];
          }
        }
      } catch (e) {
        console.error("ERRO ISSUES ADSETS:", e);
      }
    }

    // 🔥 VEICULAÇÃO (status detalhado dos anúncios, igual ao Gerenciador de Anúncios)
    const veiculacaoPorCampanha: Record<string, string> = {};

    if (token && contaAnunciosId) {
      try {
        const adsResp = await fetch(
          `https://graph.facebook.com/v19.0/${contaAnunciosId}/ads?fields=id,campaign_id,effective_status&limit=500&access_token=${token}`
        ).then(r => r.json());

        console.log("META ADS EFFECTIVE STATUS:", JSON.stringify(adsResp));

        const prioridade = [
          "WITH_ISSUES",
          "DISAPPROVED",
          "PENDING_BILLING_INFO",
          "PENDING_REVIEW",
          "IN_PROCESS",
          "PREAPPROVED",
          "ADSET_PAUSED",
          "CAMPAIGN_PAUSED",
          "PAUSED",
          "ACTIVE",
          "ARCHIVED",
          "DELETED"
        ];

        const statusPorCampanha: Record<string, string[]> = {};

        for (const ad of adsResp.data || []) {
          if (!ad.campaign_id || !ad.effective_status) continue;

          statusPorCampanha[ad.campaign_id] =
            statusPorCampanha[ad.campaign_id] || [];
          statusPorCampanha[ad.campaign_id].push(ad.effective_status);
        }

        for (const [campaignId, statuses] of Object.entries(statusPorCampanha)) {
          const melhorStatus = prioridade.find(p => statuses.includes(p));
          if (melhorStatus) {
            veiculacaoPorCampanha[campaignId] = melhorStatus;
          }
        }
      } catch (e) {
        console.error("ERRO ADS EFFECTIVE STATUS:", e);
      }
    }

    // Detecção de nicho por nome para campanhas sem nicho_id no BD
    const userNichos = (user.nichos || []) as Array<{id: number; slug: string; nome: string; cor: string}>;
    if (userNichos.length > 0) {
      const norm = (t: string) =>
        String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const saasNicho = userNichos.find(n => n.slug === "saas" || norm(n.nome).includes("saas") || norm(n.nome).includes("plataforma"));
      for (const c of campanhas.rows as any[]) {
        // Migra nicho legado "Plataforma" para o nicho SaaS atual do usuário
        if (saasNicho && c.nicho_nome && /^plataforma$/i.test(c.nicho_nome.trim())) {
          c.nicho_id   = saasNicho.id;
          c.nicho_slug = saasNicho.slug;
          c.nicho_nome = saasNicho.nome;
          c.nicho_cor  = saasNicho.cor;
          continue;
        }
        if (c.nicho_id || c.nicho_slug) continue;
        const nomeLower = norm(c.nome || "");
        for (const nicho of userNichos) {
          const nichoNomeLower = norm(nicho.nome || "");
          if (nomeLower.includes(nichoNomeLower) || nomeLower.includes(nicho.slug)) {
            c.nicho_id   = nicho.id;
            c.nicho_slug = nicho.slug;
            c.nicho_nome = nicho.nome;
            c.nicho_cor  = nicho.cor;
            break;
          }
        }
      }
    }

    const metricas = [];

    for (const campanha of campanhas.rows) {

      let dados: any = {};
      let grafico: any[] = [];
      let gastoHojeCampanha = 0;
      let metaDisponivel = false;
      let erroMeta: string | null = null;

      if (
        token &&
        campanha.campaign_id &&
        String(campanha.status || "").toUpperCase() !== "DELETED"
      ) {
        try {
          const [insightsTotais, insightsGrafico, insightsHoje] = await Promise.all([
            fetch(
              `https://graph.facebook.com/v19.0/${campanha.campaign_id}/insights?fields=impressions,clicks,spend,cpc,ctr,reach,actions,cost_per_action_type&date_preset=last_30d&access_token=${token}`
            ).then(r => r.json()),
            fetch(
              `https://graph.facebook.com/v19.0/${campanha.campaign_id}/insights?fields=impressions,clicks,spend,ctr&time_increment=1&date_preset=last_30d&access_token=${token}`
            ).then(r => r.json()),
            fetch(
              `https://graph.facebook.com/v19.0/${campanha.campaign_id}/insights?fields=spend&date_preset=today&access_token=${token}`
            ).then(r => r.json())
          ]);

          if (insightsTotais.error) {
            erroMeta =
              insightsTotais.error.message ||
              "Métricas indisponíveis na Meta";
          } else {
            dados = insightsTotais.data?.[0] || {};

            const diasGrafico = insightsGrafico.data || [];

            grafico = diasGrafico.map((d: any) => ({
              data: d.date_start,
              clicks: Number(d.clicks || 0),
              ctr: Number(d.ctr || 0),
              gasto: Number(d.spend || 0),
              impressoes: Number(d.impressions || 0)
            }));

            gastoHojeCampanha = Number(insightsHoje.data?.[0]?.spend || 0);

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

      // 🔥 ERRO DE PAGAMENTO REPORTADO PELA META
      const issuesCampanha =
        issuesPorCampanha[campanha.campaign_id] || [];

      const issuePagamento = issuesCampanha.find((i: any) =>
        /pagamento|payment|billing|cobran/i.test(
          `${i.error_summary || ""} ${i.error_message || ""}`
        )
      );

      const campanhaAtiva =
        ["ACTIVE", "ENABLED"].includes(
          String(campanha.status || "").toUpperCase()
        );

      const mensagemErroPagamento =
        (issuePagamento &&
          (issuePagamento.error_summary || issuePagamento.error_message)) ||
        (campanhaAtiva ? erroPagamentoConta : null);

      // 🔥 VEICULAÇÃO (status detalhado igual ao Gerenciador de Anúncios)
      const veiculacaoStatus =
        veiculacaoPorCampanha[campanha.campaign_id] || null;

      // Corrige divergência de status entre banco e Meta automaticamente.
      // Ex.: usuário pausou direto na Meta → banco ainda mostra ACTIVE.
      const statusMetaCampanha =
        veiculacaoStatus === "CAMPAIGN_PAUSED" ? "PAUSED"
        : veiculacaoStatus === "ACTIVE"        ? "ACTIVE"
        : null;

      if (
        statusMetaCampanha &&
        statusMetaCampanha !== String(campanha.status || "").toUpperCase()
      ) {
        client.query(
          `UPDATE campanhas SET status = $1, atualizado_em = NOW() WHERE id = $2`,
          [statusMetaCampanha, campanha.id]
        ).catch(() => {});
        campanha.status = statusMetaCampanha;
      }

      const diagnosticoVeiculacao =
        diagnosticarVeiculacaoMeta(
          veiculacaoStatus,
          issuesCampanha,
          mensagemErroPagamento || erroPagamentoConta,
          campanha.status
        );

      // Persiste nicho detectado pelas tabelas de detalhe ou leads
      if (!campanha.nicho_id && campanha.nicho_slug) {
        client.query(
          `UPDATE campanhas SET nicho_id = (SELECT id FROM nichos WHERE slug = $1 LIMIT 1) WHERE id = $2`,
          [campanha.nicho_slug, campanha.id]
        ).catch(() => {});
      }

      console.log(
        "ERRO PAGAMENTO CAMPANHA:",
        campanha.nome,
        "status:", campanha.status,
        "campanhaAtiva:", campanhaAtiva,
        "erroPagamentoConta:", erroPagamentoConta,
        "mensagemErroPagamento:", mensagemErroPagamento
      );

      const configuracoesCampanha = {
        ...(campanha.configuracoes_avancadas || {}),
        tipo_imovel: campanha.tipo_imovel ?? campanha.configuracoes_avancadas?.tipo_imovel,
        finalidade: campanha.finalidade ?? campanha.configuracoes_avancadas?.finalidade,
        valor_min: campanha.valor_min ?? campanha.configuracoes_avancadas?.valor_min,
        valor_max: campanha.valor_max ?? campanha.configuracoes_avancadas?.valor_max,
        regiao: campanha.regiao ?? campanha.configuracoes_avancadas?.regiao,
        operadora: campanha.operadora ?? campanha.configuracoes_avancadas?.operadora,
        tipo_plano: campanha.tipo_plano ?? campanha.configuracoes_avancadas?.tipo_plano,
        faixa_etaria_min: campanha.faixa_etaria_min ?? campanha.configuracoes_avancadas?.faixa_etaria_min,
        faixa_etaria_max: campanha.faixa_etaria_max ?? campanha.configuracoes_avancadas?.faixa_etaria_max,
        cobertura: campanha.cobertura ?? campanha.configuracoes_avancadas?.cobertura,
        acomodacao: campanha.acomodacao ?? campanha.configuracoes_avancadas?.acomodacao,
        produto: campanha.produto ?? campanha.configuracoes_avancadas?.produto,
        objetivo: campanha.objetivo_nicho ?? campanha.configuracoes_avancadas?.objetivo,
        marca: campanha.marca ?? campanha.configuracoes_avancadas?.marca,
        publico_alvo: campanha.publico_alvo ?? campanha.configuracoes_avancadas?.publico_alvo
      };

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
        corretores_encaminhados:
          (campanha.corretores_encaminhados || []).map((cor: any) => ({
            id: cor.id,
            email: cor.email,
            nome:
              [cor.nome, cor.sobrenome]
                .filter(Boolean).join(" ") || cor.email
          })),
        corretores_envio_historico:
          (campanha.corretores_envio_historico || []).map((cor: any) => ({
            id: cor.id,
            email: cor.email,
            status: cor.status,
            atualizado_em: cor.atualizado_em,
            nome:
              [cor.nome, cor.sobrenome]
                .filter(Boolean).join(" ") || cor.email
          })),
        recebida_por_encaminhamento:
          Number(campanha.usuario_id) !== Number(user.id),
        configuracoes_avancadas:
          configuracoesCampanha,
        daily_budget:
          campanha.daily_budget || null,

        impressoes: dados.impressions || 0,
        cliques: dados.clicks || 0,
        alcance: dados.reach || 0,
        gasto: dados.spend || 0,
        gasto_hoje: gastoHojeCampanha,
        cpc: dados.cpc || 0,
        ctr: dados.ctr || 0,

        // 🔥 agora vem da sua plataforma
        leads: totalLeadsBanco,

        grafico,
        criado_em: campanha.criado_em,
        metricas_origem: metaDisponivel ? "meta" : "local",
        meta_disponivel: metaDisponivel,
        erro_meta: erroMeta,
        erro_publicacao:
          campanha.configuracoes_avancadas?.ultimo_erro_publicacao || null,
        erro_pagamento: mensagemErroPagamento || null,
        veiculacao: veiculacaoStatus,
        veiculacao_label: traduzirVeiculacaoMeta(veiculacaoStatus),
        veiculacao_tipo: diagnosticoVeiculacao.tipo,
        veiculacao_subcategoria: diagnosticoVeiculacao.subcategoria,
        veiculacao_motivo: diagnosticoVeiculacao.motivo,
        veiculacao_acao: diagnosticoVeiculacao.acao,
        veiculacao_acao_passos: diagnosticoVeiculacao.acao_passos,
        veiculacao_acao_url: urlAcaoVeiculacaoMeta(
          diagnosticoVeiculacao.subcategoria,
          campanha.campaign_id || null,
          campanha.conta_anuncios_id || null
        ),
        veiculacao_detalhes: diagnosticoVeiculacao.detalhes,
        conta_anuncios_id: campanha.conta_anuncios_id || null,
        nicho_id: campanha.nicho_id || null,
        nicho_slug: campanha.nicho_slug || null,
        nicho_nome: campanha.nicho_nome || null,
        nicho_cor: campanha.nicho_cor || null
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

    const campaignIdsUsuario =
      await listarCampaignIdsMetaDoUsuario(
        Number(user.id),
        adAccountId
      );

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
      `https://graph.facebook.com/v19.0/${adAccountId}/insights?fields=campaign_id,spend,actions,impressions,clicks,reach&level=campaign&time_increment=1&time_range=${timeRange}&access_token=${token}`
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

    const metaPorDia = new Map();

    for (const linha of insights.data || []) {
      const campaignId =
        String(linha.campaign_id || "");

      if (!campaignIdsUsuario.has(campaignId)) {
        continue;
      }

      const dataLinha =
        linha.date_start;

      const atual =
        metaPorDia.get(dataLinha) || {
          date_start: dataLinha,
          spend: 0,
          leads: 0,
          clicks: 0,
          impressions: 0,
          reach: 0
        };

      atual.spend += Number(linha.spend || 0);
      atual.leads += extrairLeadsActionsMeta(linha.actions || []);
      atual.clicks += Number(linha.clicks || 0);
      atual.impressions += Number(linha.impressions || 0);
      atual.reach += Number(linha.reach || 0);

      metaPorDia.set(dataLinha, atual);
    }

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
          Number(linha.leads || 0);
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
    const campaignIdsUsuario =
      await listarCampaignIdsMetaDoUsuario(
        Number(user.id),
        adAccountId
      );
    const timeRange = encodeURIComponent(JSON.stringify({ since: data, until: data }));

    const insights = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/insights?fields=campaign_name,campaign_id,spend,actions,clicks,impressions&level=campaign&time_range=${timeRange}&access_token=${token}`
    ).then(r => r.json());

    if (insights.error) {
      return c.json({ error: "Erro ao buscar dados da Meta", detalhe: insights.error }, 400);
    }

    const campanhas = (insights.data || [])
      .filter((item: any) =>
        campaignIdsUsuario.has(String(item.campaign_id || ""))
      )
      .map((item: any) => {
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
    let contaAds;

    try {

      contaAds =
        await obterContaAnuncios(
          token,
          conn.rows[0].conta_anuncios_id
        );

    } catch (erroConta: any) {

      return c.json({
        error: erroConta?.message ||
          "Selecione a conta de anúncios Meta que deseja usar."
      }, 400);
    }

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
        AND usuario_id = $2
        `,
        [campanha.id, user.id]
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
          AND usuario_id = $5
          `,
          [
            campanha.name,
            statusFinal,
            adAccountId,
            campanha.id,
            user.id
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
          SELECT nome, nicho_id
          FROM campanhas
          WHERE form_id = $1
          AND conta_anuncios_id = $2
          AND usuario_id = $3
          LIMIT 1
          `,
          [form.id, adAccountId, user.id]
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

        const nichoIdSync: number | null =
          campanhaBanco.rows[0]?.nicho_id ?? null;
        
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
            AND usuario_id = $2
            `,
            [lead.id, user.id]
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
              nicho_id,
              criado_em
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()
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
              JSON.stringify(respostasQualificacao),
              nichoIdSync
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

    const campanhaBanco = await client.query(
      `
      SELECT id, adset_id, ad_id, usuario_id, conta_anuncios_id
      FROM campanhas
      WHERE campaign_id = $1
      AND (
        usuario_id = $2
        OR EXISTS (
          SELECT 1
          FROM campanha_corretores cc
          WHERE cc.campanha_id = campanhas.id
          AND cc.usuario_id = $2
        )
      )
      LIMIT 1
      `,
      [campaign_id, user.id]
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



    // 🔐 TOKEN — sempre usa a conta Meta do próprio usuário que está publicando
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
      AND (conta_anuncios_id = $3 OR conta_anuncios_id IS NULL)
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
      const errCode = Number(metaRes.error?.code) || 0;
      const errMsg = (metaRes.error?.message || "").toLowerCase();

      // Campanha não existe mais no Meta (inválida, já excluída lá ou nunca criada):
      // marca como deletada localmente sem bloquear o usuário
      const naoPertenceMaisMeta =
        errCode === 803 ||   // no such object
        errCode === 100 ||   // invalid parameter (inclui IDs inexistentes)
        errMsg.includes("invalid parameter") ||
        errMsg.includes("no such") ||
        errMsg.includes("does not exist") ||
        errMsg.includes("deleted");

      if (!naoPertenceMaisMeta) {
        return c.json({
          error: metaRes.error?.error_user_msg || metaRes.error?.message || "Erro ao excluir no Meta"
        }, 400);
      }

      console.log("EXCLUIR: campanha não encontrada no Meta, removendo localmente:", campaign_id);
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


// 🔹 excluir definitivamente uma campanha da plataforma
app.delete("/campanhas/:id/definitiva", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    const campanhaId =
      Number(c.req.param("id"));

    if (!Number.isFinite(campanhaId)) {
      return c.json({
        error: "Campanha inválida"
      }, 400);
    }

    const campanha = await client.query(
      `
      SELECT id, campaign_id, status
      FROM campanhas
      WHERE id = $1
      AND usuario_id = $2
      LIMIT 1
      `,
      [campanhaId, user.id]
    );

    if (!campanha.rows.length) {
      return c.json({
        error: "Apenas o dono da campanha pode excluí-la definitivamente"
      }, 403);
    }

    const campanhaLocal =
      campanha.rows[0];

    const statusAtual =
      String(campanhaLocal.status || "").toUpperCase();

    if (
      campanhaLocal.campaign_id &&
      statusAtual !== "DELETED"
    ) {
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

      if (token) {
        const metaRes = await fetch(
          `https://graph.facebook.com/v19.0/${campanhaLocal.campaign_id}`,
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

        console.log("DELETE DEFINITIVO META:", metaRes);

        if (metaRes.error) {
          return c.json({
            error:
              metaRes.error.message ||
              "A Meta não permitiu excluir a campanha"
          }, 400);
        }
      }
    }

    await client.query(
      `
      DELETE FROM campanhas
      WHERE id = $1
      AND usuario_id = $2
      `,
      [campanhaId, user.id]
    );

    return c.json({
      sucesso: true
    });

  } catch (err) {

    console.error("EXCLUIR CAMPANHA DEFINITIVA:", err);

    return c.json({
      error: "Erro ao excluir campanha definitivamente"
    }, 500);
  }
});

// 🔹 editar segmentação, orçamento, datas e lance de uma campanha existente
app.post("/meta/editar-campanha", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    const {
      usuario_id,
      campaign_id,
      daily_budget,
      configuracoes_avancadas
    } = await c.req.json();

    const usuarioId =
      resolverUsuarioIdOperacao(user, usuario_id);

    if (!usuarioId) {
      return negarAcessoConta(c);
    }

    const contaAnunciosId =
      await obterContaAnunciosSelecionadaIdUsuario(
        usuarioId
      );

    const campanhaBanco = await client.query(
      `
      SELECT id, adset_id
      FROM campanhas
      WHERE campaign_id = $1
      AND (
        usuario_id = $2
        OR encaminhada_para_usuario_id = $2
      )
      AND conta_anuncios_id = $3
      LIMIT 1
      `,
      [campaign_id, usuarioId, contaAnunciosId]
    );

    if (!campanhaBanco.rows.length) {
      return c.json({
        error: "Campanha não disponível para este usuário"
      }, 404);
    }

    const adsetId =
      campanhaBanco.rows[0]?.adset_id;

    if (!adsetId) {
      return c.json({
        error: "Conjunto de anúncios não encontrado para esta campanha"
      }, 400);
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
      [usuarioId]
    );

    if (!conn.rows.length) {
      return c.json({
        error: "Meta não conectada"
      }, 400);
    }

    const token = conn.rows[0].access_token;

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

    const { bidStrategy, bidAmount } =
      prepararControleCustoMeta(
        avancadas.bid_strategy,
        avancadas.bid_amount
      );

    const inicio =
      textoOpcional(avancadas.inicio);

    const fim =
      textoOpcional(avancadas.fim);

    const dailyBudget =
      numeroOpcional(daily_budget);

    const payloadAdset: any = {
      targeting,
      access_token: token
    };

    if (bidStrategy) {
      payloadAdset.bid_strategy = bidStrategy;
    }

    if (dailyBudget !== null) {
      payloadAdset.daily_budget = dailyBudget;
    }

    if (
      bidAmount !== null &&
      bidStrategyExigeValor(bidStrategy)
    ) {
      payloadAdset.bid_amount =
        Math.round(bidAmount * 100);
    }

    if (fim) {
      payloadAdset.end_time =
        new Date(fim).toISOString();
    }

    if (inicio) {
      const inicioData = new Date(inicio);

      if (inicioData.getTime() > Date.now()) {
        payloadAdset.start_time =
          inicioData.toISOString();
      }
    }

    const adsetRes = await enviarPayloadMetaComFallbackBid(
      `https://graph.facebook.com/v19.0/${adsetId}`,
      payloadAdset,
      "EDITAR_ADSET"
    );

    console.log(
      "EDITAR CAMPANHA PAYLOAD:",
      JSON.stringify(payloadAdset, null, 2)
    );

    console.log("EDITAR CAMPANHA RESPONSE:", adsetRes);

    if (adsetRes.error) {
      return c.json({
        error: adsetRes.error,
        targeting_enviado: targeting
      }, 400);
    }

    await client.query(
      `
      UPDATE campanhas
      SET
        configuracoes_avancadas = $1,
        daily_budget = COALESCE($2, daily_budget),
        atualizado_em = NOW()
      WHERE id = $3
      `,
      [
        JSON.stringify(avancadas),
        dailyBudget,
        campanhaBanco.rows[0].id
      ]
    );

    return c.json({
      sucesso: true
    });

  } catch (err) {

    console.error("EDITAR CAMPANHA:", err);

    return c.json({
      error: "Erro ao editar campanha"
    }, 500);
  }
});


app.post("/campanhas/:id/publicar-recebida", authMiddleware, async (c) => {

  let campanhaId = 0;
  let campaignMetaId: string | null = null;
  let token = "";

  const falhar = async (
    mensagem: string,
    detalhe: any = null,
    status = 400
  ) => {
    if (campanhaId) {
      await registrarErroPublicacaoCampanha(campanhaId, mensagem);
    }

    if (campaignMetaId && token) {
      await fetch(
        `https://graph.facebook.com/v19.0/${campaignMetaId}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ access_token: token })
        }
      ).catch(() => null);
    }

    return c.json({
      error: mensagem,
      detalhe
    }, status);
  };

  try {

    const user: any = c.get("user");

    campanhaId =
      Number(c.req.param("id"));

    if (!Number.isFinite(campanhaId) || campanhaId <= 0) {
      return c.json({
        error: "Campanha inválida"
      }, 400);
    }

    const campanhaRes = await client.query(
      `
      SELECT c.*
      FROM campanhas c
      WHERE c.id = $1
      AND (
        c.usuario_id = $2
        OR EXISTS (
          SELECT 1
          FROM campanha_corretores cc
          WHERE cc.campanha_id = c.id
          AND cc.usuario_id = $2
        )
      )
      LIMIT 1
      `,
      [campanhaId, user.id]
    );

    if (!campanhaRes.rows.length) {
      return c.json({
        error: "Campanha não disponível para este usuário"
      }, 404);
    }

    const campanha = campanhaRes.rows[0];
    const cfg = campanha.configuracoes_avancadas || {};

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

    if (!conn.rows.length) {
      return await falhar(
        "Meta não conectada. Conecte sua conta Meta antes de publicar esta campanha."
      );
    }

    token = conn.rows[0].access_token;

    const contaAds =
      await obterContaAnuncios(
        token,
        conn.rows[0].conta_anuncios_id
      );

    if (!contaAds) {
      return await falhar(
        "Nenhuma conta de anúncios encontrada na Meta conectada."
      );
    }

    const adAccountId = contaAds.id;

    const pages = await fetch(
      `https://graph.facebook.com/v19.0/me/accounts?access_token=${token}`
    ).then(r => r.json());

    if (!Array.isArray(pages.data) || !pages.data.length) {
      return await falhar(
        "Nenhuma Página do Facebook encontrada na Meta conectada. Configure uma página antes de publicar."
      );
    }

    let page =
      pages.data.find((p: any) => p.id === textoOpcional(cfg.page_id)) ||
      pages.data[0];

    const pageId =
      page.id;

    const pageToken =
      page.access_token;

    if (!pageId || !pageToken) {
      return await falhar(
        "A Página selecionada não retornou token de acesso. Reconecte a Meta e tente novamente."
      );
    }

    const valorOrcamento =
      Number(campanha.daily_budget || cfg.daily_budget || cfg.orcamento_diario_centavos || 0) ||
      Math.round(Number(cfg.orcamento || cfg.orcamento_diario || 20) * 100);

    const dailyBudget =
      Math.max(100, Math.round(valorOrcamento));

    const categoriaEspecial =
      textoOpcional(cfg.categoria_especial);

    const payloadCampanha: any = {
      name: campanha.nome || cfg.nome || "Campanha Leads Plataforma",
      objective: "OUTCOME_LEADS",
      status: "ACTIVE",
      special_ad_categories: categoriaEspecial ? [categoriaEspecial] : [],
      is_adset_budget_sharing_enabled: false,
      access_token: token
    };

    if (cfg.cbo ?? true) {
      payloadCampanha.daily_budget = dailyBudget;
    }

    const campanhaMeta = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/campaigns`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadCampanha)
      }
    ).then(r => r.json());

    if (!campanhaMeta.id) {
      return await falhar(
        mensagemErroMeta(campanhaMeta, "Erro ao criar campanha na Meta"),
        campanhaMeta
      );
    }

    campaignMetaId = campanhaMeta.id;

    const perguntasExtras =
      Array.isArray(cfg.perguntas)
        ? cfg.perguntas
        : Array.isArray(cfg.perguntas_qualificacao)
          ? cfg.perguntas_qualificacao
          : [];

    const payloadFormulario: any = {
      name: `Form ${campanha.nome || "Leads"} ${Date.now()}`,
      locale: "pt_BR",
      questions: [
        { type: "FULL_NAME" },
        { type: "EMAIL" },
        { type: "PHONE" },
        ...perguntasExtras.slice(0, 4).map((pergunta: string, index: number) => ({
          type: "CUSTOM",
          key: `qualificacao_${index + 1}`,
          label: pergunta
        }))
      ],
      privacy_policy: {
        url: urlOpcional(cfg.privacidade_url || cfg.url_privacidade, "https://google.com"),
        link_text:
          textoOpcional(cfg.privacidade_texto) ||
          "Política de Privacidade"
      },
      thank_you_page: {
        title:
          textoOpcional(cfg.obrigado_titulo) ||
          textoOpcional(cfg.mensagem_agradecimento_titulo) ||
          "Obrigado!",
        body:
          textoOpcional(cfg.obrigado_texto) ||
          textoOpcional(cfg.mensagem_agradecimento) ||
          "Recebemos seus dados 🚀",
        button_type: "VIEW_WEBSITE",
        button_text:
          textoOpcional(cfg.obrigado_botao) ||
          "Ver mais",
        website_url: urlOpcional(
          cfg.obrigado_url || cfg.url_privacidade || cfg.privacidade_url,
          "https://google.com"
        )
      },
      access_token: pageToken
    };

    if (cfg.formulario_qualidade) {
      payloadFormulario.is_optimized_for_quality = true;
    }

    const formMeta = await fetch(
      `https://graph.facebook.com/v19.0/${pageId}/leadgen_forms`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadFormulario)
      }
    ).then(r => r.json());

    if (!formMeta.id) {
      return await falhar(
        mensagemErroMeta(formMeta, "Erro ao criar formulário de leads na Meta"),
        formMeta
      );
    }

    const targeting =
      montarTargetingMeta(cfg);

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

    const controleCusto =
      prepararControleCustoMeta(
        cfg.bid_strategy,
        cfg.bid_amount
      );

    const payloadAdset: any = {
      name: `AdSet ${campanha.nome || "Leads"} ${Date.now()}`,
      campaign_id: campanhaMeta.id,
      billing_event: "IMPRESSIONS",
      optimization_goal: "LEAD_GENERATION",
      destination_type: "ON_AD",
      start_time: new Date(Date.now() + 60000).toISOString(),
      targeting,
      promoted_object: {
        page_id: pageId
      },
      status: "ACTIVE",
      access_token: token
    };

    if (controleCusto.bidStrategy) {
      payloadAdset.bid_strategy =
        controleCusto.bidStrategy;
    }

    if (!(cfg.cbo ?? true)) {
      payloadAdset.daily_budget = dailyBudget;
    }

    if (
      controleCusto.bidAmount !== null &&
      bidStrategyExigeValor(payloadAdset.bid_strategy)
    ) {
      payloadAdset.bid_amount =
        Math.round(controleCusto.bidAmount * 100);
    }

    const fim =
      textoOpcional(cfg.fim);

    if (fim) {
      payloadAdset.end_time =
        new Date(fim).toISOString();
    }

    const adsetMeta = await enviarPayloadMetaComFallbackBid(
      `https://graph.facebook.com/v19.0/${adAccountId}/adsets`,
      payloadAdset,
      "PUBLICAR_RECEBIDA_ADSET"
    );

    if (!adsetMeta.id) {
      return await falhar(
        mensagemErroMeta(adsetMeta, "Erro ao criar conjunto de anúncios na Meta"),
        adsetMeta
      );
    }

    const imageUrls =
      [
        ...(Array.isArray(cfg.imagens_urls) ? cfg.imagens_urls : []),
        ...(Array.isArray(cfg.image_urls) ? cfg.image_urls : [])
      ].filter(Boolean);

    const hashes: string[] = [];

    for (const urlImagem of imageUrls) {
      const uploadImagem =
        await enviarImagemMetaPorUrl(token, adAccountId, String(urlImagem));

      if (uploadImagem.hash) {
        hashes.push(uploadImagem.hash);
      }
    }

    if (!hashes.length) {
      if (Array.isArray(cfg.imageHashes)) {
        hashes.push(...cfg.imageHashes.filter(Boolean));
      } else if (cfg.imageHash) {
        hashes.push(cfg.imageHash);
      }
    }

    if (!hashes.length) {
      return await falhar(
        "Imagem da campanha não encontrada. Edite a campanha e adicione uma imagem antes de publicar."
      );
    }

    const linkDestino =
      urlOpcional(cfg.link, "https://google.com");

    const tituloAnuncio =
      textoOpcional(cfg.titulo) ||
      campanha.nome ||
      "Saiba mais";

    const descricaoAnuncio =
      textoOpcional(cfg.descricao) ||
      "Entre em contato agora";

    const ctaType =
      textoOpcional(cfg.cta) ||
      "LEARN_MORE";

    const isCarrossel =
      hashes.length > 1;

    const linkDataBase: Record<string, any> = {
      message:
        textoOpcional(cfg.texto) ||
        textoOpcional(campanha.texto) ||
        "Entre em contato agora"
    };

    if (isCarrossel) {
      linkDataBase.child_attachments = hashes.map((hash, index) => ({
        link: linkDestino,
        image_hash: hash,
        name: index === 0 ? tituloAnuncio : `Slide ${index + 1}`,
        description: descricaoAnuncio,
        call_to_action: {
          type: ctaType,
          value: { lead_gen_form_id: formMeta.id }
        }
      }));
      linkDataBase.multi_share_end_card = false;
    } else {
      linkDataBase.link = linkDestino;
      linkDataBase.image_hash = hashes[0];
      linkDataBase.name = tituloAnuncio;
      linkDataBase.description = descricaoAnuncio;
      linkDataBase.call_to_action = {
        type: ctaType,
        value: { lead_gen_form_id: formMeta.id }
      };
    }

    const objectStorySpec: Record<string, any> = {
      page_id: pageId,
      link_data: linkDataBase
    };

    if (Array.isArray(cfg.plataformas) && cfg.plataformas.includes("instagram")) {
      const instagramActorId =
        textoOpcional(cfg.instagram_actor_id) ||
        (await listarContasInstagramAnuncio(token, adAccountId))[0]?.id ||
        null;

      if (instagramActorId) {
        objectStorySpec.instagram_actor_id = instagramActorId;
      }
    }

    const creativeMeta = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/adcreatives`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Criativo Leads ${Date.now()}`,
          object_story_spec: objectStorySpec,
          access_token: token
        })
      }
    ).then(r => r.json());

    if (!creativeMeta.id) {
      return await falhar(
        mensagemErroMeta(creativeMeta, "Erro ao criar criativo na Meta"),
        creativeMeta
      );
    }

    const adMeta = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/ads`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Anúncio Leads ${Date.now()}`,
          adset_id: adsetMeta.id,
          creative: {
            creative_id: creativeMeta.id
          },
          status: "ACTIVE",
          access_token: token
        })
      }
    ).then(r => r.json());

    if (!adMeta.id) {
      return await falhar(
        mensagemErroMeta(adMeta, "Erro ao criar anúncio na Meta"),
        adMeta
      );
    }

    const configuracoesPublicadas = {
      ...cfg,
      page_id: pageId,
      form_id: formMeta.id,
      creative_id: creativeMeta.id,
      adset_id: adsetMeta.id,
      ad_id: adMeta.id,
      imageHashes: hashes,
      imageHash: hashes[0] || null,
      publicado_por_usuario_id: user.id,
      publicado_em: new Date().toISOString()
    };

    await client.query(
      `
      UPDATE campanhas
      SET
        campaign_id = $1,
        adset_id = $2,
        ad_id = $3,
        form_id = $4,
        page_id = $5,
        conta_anuncios_id = $6,
        status = 'ACTIVE',
        origem = 'plataforma',
        daily_budget = $7,
        configuracoes_avancadas = $8,
        atualizado_em = NOW()
      WHERE id = $9
      `,
      [
        campanhaMeta.id,
        adsetMeta.id,
        adMeta.id,
        formMeta.id,
        pageId,
        adAccountId,
        dailyBudget,
        JSON.stringify(configuracoesPublicadas),
        campanhaId
      ]
    );

    await limparErroPublicacaoCampanha(campanhaId);

    return c.json({
      sucesso: true,
      campaign_id: campanhaMeta.id,
      adset_id: adsetMeta.id,
      ad_id: adMeta.id,
      form_id: formMeta.id
    });

  } catch (err: any) {

    console.error("PUBLICAR CAMPANHA RECEBIDA:", err);

    return await falhar(
      err?.message || "Erro ao publicar campanha recebida",
      err,
      500
    );
  }
});


// 🔹 criar lead
// 🧪 TESTE TEMPORÁRIO — enviar notif WhatsApp para leads das últimas 24h
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

    await notificarNovoLeadWhatsApp(user.id, { nome: body.nome, telefone: body.telefone, email: body.email });

    return c.json({ message: "Lead salvo com sucesso" });
  } catch (err) {
    console.error("LEAD ERROR:", err);
    return c.json({ error: "Erro ao salvar lead" }, 500);
  }
});

// 🔹 leads por plataforma (stats para o dashboard)
app.get("/leads/stats/plataformas", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const result = await client.query(
      `SELECT COALESCE(plataforma, 'meta') AS plataforma, COUNT(*)::int AS total
       FROM leads
       WHERE usuario_id = $1
       GROUP BY COALESCE(plataforma, 'meta')
       ORDER BY total DESC`,
      [user.id]
    );
    return c.json(result.rows);
  } catch (err) {
    console.error("ERRO stats plataformas:", err);
    return c.json({ error: "Erro ao carregar stats" }, 500);
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
        l.id,
        l.nome,
        l.telefone,
        l.email,
        l.status,
        l.origem,
        l.campanha,
        l.observacao,
        l.score,
        l.score_manual,
        l.motivo_perda,
        l.respostas_qualificacao,
        l.criado_em,
        l.nicho_id,
        n.slug AS nicho_slug,
        n.nome AS nicho_nome,
        n.cor  AS nicho_cor,
        l.data_contato,
        l.observacao_agendamento,
        COALESCE(l.plataforma, 'meta') AS plataforma
      FROM leads l
      LEFT JOIN nichos n ON n.id = l.nicho_id
      WHERE l.usuario_id = $1
      AND (
        COALESCE(l.origem, 'manual') <> 'meta'
        OR l.conta_anuncios_id = $2
      )
      ORDER BY l.criado_em DESC
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
      usoIA?.custo_estimado || IA_CUSTO_ESTIMADO_PADRAO,
      Number(usoIA?.usage?.input_tokens || 0),
      Number(usoIA?.usage?.output_tokens || 0),
      usoIA?.provider || "openai"
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

    const leadAtualizado =
      result.rows[0];
    const scoreData =
      calcularScoreLead(leadAtualizado);

    leadAtualizado.score =
      scoreData.score;
    leadAtualizado.score_base =
      scoreData.base;
    leadAtualizado.score_pontos =
      scoreData.pontos;

    return c.json({
      success: true,
      lead: leadAtualizado
    });

  } catch (err) {

    console.error("UPDATE LEAD ERROR:", err);

    return c.json({
      error: "Erro ao atualizar lead"
    }, 500);
  }
});



// 🔹 excluir lead
app.delete("/leads/:id", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "ID inválido" }, 400);

    const result = await client.query(
      `DELETE FROM leads WHERE id = $1 AND usuario_id = $2 RETURNING id`,
      [id, user.id]
    );

    if (!result.rows.length) return c.json({ error: "Lead não encontrado ou sem permissão" }, 404);

    return c.json({ message: "Lead excluído com sucesso" });
  } catch (err) {
    console.error("ERRO AO EXCLUIR LEAD:", err);
    return c.json({ error: "Erro ao excluir lead" }, 500);
  }
});

// 🔹 agendar data de contato do lead
app.patch("/leads/:id/data-contato", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const leadId = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => ({}));
    const dataContato = body.data_contato ?? null;
    const observacaoAgendamento = body.observacao_agendamento ?? null;

    // busca o lead e o dono para checar permissão em JS
    const leadRow = await client.query(`SELECT id, usuario_id FROM leads WHERE id = $1`, [leadId]);
    if (!leadRow.rows[0]) return c.json({ error: "Lead não encontrado" }, 404);

    const leadOwnerId: number = leadRow.rows[0].usuario_id;
    const ownerRow = await client.query(`SELECT id, admin_id FROM usuarios WHERE id = $1`, [leadOwnerId]);
    const leadOwnerAdminId: number | null = ownerRow.rows[0]?.admin_id ?? null;

    const uid = Number(user.id);
    const temPermissao =
      Number(leadOwnerId) === uid ||           // lead é do próprio usuário
      Number(user.admin_id) === Number(leadOwnerId) ||  // corretor acessando lead do seu admin
      Number(leadOwnerAdminId) === uid;        // admin acessando lead de um corretor dele

    if (!temPermissao) {
      console.error("PERMISSAO NEGADA data-contato:", { leadOwnerId, userId: user.id, userAdminId: user.admin_id, leadOwnerAdminId });
      return c.json({ error: "Sem permissão para editar este lead" }, 403);
    }

    const res = await client.query(
      `UPDATE leads
       SET data_contato = $1,
           observacao_agendamento = $2,
           lembrete_1dia_enviado = FALSE,
           lembrete_dia_enviado  = FALSE
       WHERE id = $3
       RETURNING id, data_contato, observacao_agendamento`,
      [dataContato, observacaoAgendamento, leadId]
    );

    if (!res.rows[0]) return c.json({ error: "Falha ao atualizar" }, 500);
    return c.json(res.rows[0]);
  } catch (err: any) {
    console.error("ERRO DATA CONTATO:", err);
    return c.json({ error: "Erro ao salvar data de contato", detail: String(err?.message || err) }, 500);
  }
});

// 🔹 buscar notificações não lidas do usuário
app.get("/notificacoes", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const res = await client.query(
      `SELECT n.id, n.tipo, n.titulo, n.mensagem, n.lido, n.criado_em,
              l.nome AS lead_nome, l.telefone AS lead_telefone
       FROM notificacoes n
       LEFT JOIN leads l ON l.id = n.lead_id
       WHERE n.usuario_id = $1
       ORDER BY n.criado_em DESC
       LIMIT 50`,
      [user.id]
    );
    return c.json(res.rows);
  } catch (err) {
    console.error("ERRO NOTIFICACOES:", err);
    return c.json({ error: "Erro ao buscar notificações" }, 500);
  }
});

// 🔹 marcar notificação como lida
app.patch("/notificacoes/:id/lida", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const notifId = Number(c.req.param("id"));
    await client.query(
      `UPDATE notificacoes SET lido = TRUE WHERE id = $1 AND usuario_id = $2`,
      [notifId, user.id]
    );
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: "Erro" }, 500);
  }
});

// 🔹 marcar todas as notificações como lidas
app.patch("/notificacoes/ler-todas", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    await client.query(
      `UPDATE notificacoes SET lido = TRUE WHERE usuario_id = $1`,
      [user.id]
    );
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: "Erro" }, 500);
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
        COALESCE(u.ia_provider, 'auto') AS ia_provider,
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
        u.ia_ativo,
        u.ia_provider
      ORDER BY u.plano_ativado_em DESC NULLS LAST, u.id ASC
    `);

    const configAtual = config.rows[0] || {};
    const modeloRailway =
      textoOpcional(Bun.env.OPENAI_MODEL) || "gpt-5-mini";
    const modeloAtivo =
      textoOpcional(configAtual.modelo) || modeloRailway;

    const modelosDisponiveisRaw =
      textoOpcional(Bun.env.OPENAI_MODELOS_DISPONIVEIS) ||
      "gpt-5-mini,gpt-4o-mini,gpt-4o";
    const modelos_disponiveis = modelosDisponiveisRaw
      .split(",")
      .map((m: string) => m.trim())
      .filter(Boolean);

    const anthropicModeloAtivo =
      textoOpcional(configAtual.anthropic_modelo) || "claude-haiku-4-5-20251001";
    const anthropic_modelos_disponiveis = [
      { value: "claude-haiku-4-5-20251001", label: "Claude Haiku — Mais rapido e barato" },
      { value: "claude-sonnet-4-6",         label: "Claude Sonnet — Recomendado (qualidade)" },
      { value: "claude-opus-4-8",           label: "Claude Opus — Melhor qualidade" }
    ];

    return c.json({
      config: {
        ...configAtual,
        modelo: modeloAtivo,
        modelo_railway: modeloRailway,
        anthropic_modelo: anthropicModeloAtivo,
        chave_configurada: Boolean(Bun.env.OPENAI_API_KEY),
        anthropic_chave_configurada: Boolean(Bun.env.ANTHROPIC_API_KEY)
      },
      modelos_disponiveis,
      anthropic_modelos_disponiveis,
      resumo: resumo.rows[0],
      usuarios: usuarios.rows
    });

  } catch (err) {
    console.error("ERRO ADMIN IA:", err);
    return c.json({ error: "Erro ao carregar painel de IA" }, 500);
  }
});

app.get("/admin/ia/saldos", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    if (user.tipo !== "super_admin") return c.json({ error: "Acesso negado" }, 403);

    const gastos = await client.query(`
      SELECT
        COALESCE(provider, 'openai') AS provider,
        COUNT(*) AS chamadas,
        COALESCE(SUM(tokens_entrada), 0) AS tokens_entrada,
        COALESCE(SUM(tokens_saida), 0) AS tokens_saida,
        COALESCE(SUM(custo_estimado), 0) AS custo_total
      FROM ia_usos
      WHERE criado_em >= date_trunc('month', CURRENT_DATE)
      GROUP BY provider
    `);

    const por_provider: Record<string, any> = {};
    for (const row of gastos.rows) {
      por_provider[row.provider] = {
        chamadas: Number(row.chamadas),
        tokens_entrada: Number(row.tokens_entrada),
        tokens_saida: Number(row.tokens_saida),
        custo_total: Number(row.custo_total)
      };
    }

    const vazio = { chamadas: 0, tokens_entrada: 0, tokens_saida: 0, custo_total: 0 };

    // Tenta consultar saldo restante da OpenAI (funciona em contas pre-pagas)
    let openaiSaldo: { total_granted: number; total_used: number; total_available: number } | null = null;
    const openaiKey = Bun.env.OPENAI_API_KEY;
    if (openaiKey) {
      try {
        const resp = await fetch("https://api.openai.com/v1/dashboard/billing/credit_grants", {
          headers: { "Authorization": `Bearer ${openaiKey}` }
        });
        if (resp.ok) {
          const data: any = await resp.json();
          if (typeof data?.total_available === "number") {
            openaiSaldo = {
              total_granted: Number(data.total_granted || 0),
              total_used: Number(data.total_used || 0),
              total_available: Number(data.total_available || 0)
            };
          }
        }
      } catch { /* sem acesso a billing API */ }
    }

    // Calcula saldo Anthropic em USD a partir dos tokens rastreados
    const anthropicData = por_provider.anthropic || vazio;
    const anthropicBudgetUSD = Number(Bun.env.ANTHROPIC_BUDGET_USD || 0);
    const inputUSD = 0.25 / 1_000_000;  // claude-haiku-4-5-20251001
    const outputUSD = 1.25 / 1_000_000;
    const anthropicGastoUSD = Number(
      (anthropicData.tokens_entrada * inputUSD + anthropicData.tokens_saida * outputUSD).toFixed(6)
    );
    const anthropicSaldo = anthropicBudgetUSD > 0
      ? { budget_usd: anthropicBudgetUSD, gasto_usd: anthropicGastoUSD, saldo_usd: Math.max(0, anthropicBudgetUSD - anthropicGastoUSD) }
      : null;

    return c.json({
      openai: { ...(por_provider.openai || vazio), saldo_api: openaiSaldo },
      anthropic: { ...anthropicData, saldo_calculado: anthropicSaldo },
      atualizado_em: new Date().toISOString()
    });

  } catch (err) {
    console.error("ERRO SALDOS IA:", err);
    return c.json({ error: "Erro ao consultar saldos" }, 500);
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
        modelo = COALESCE($9, modelo),
        anthropic_modelo = COALESCE($10, anthropic_modelo),
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
        body.observacoes || null,
        textoOpcional(body.modelo) || null,
        textoOpcional(body.anthropic_modelo) || null
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

    const providerValido = ["auto", "openai", "anthropic"].includes(body.ia_provider)
      ? body.ia_provider
      : null;

    await client.query(
      `
      UPDATE usuarios
      SET
        ia_limite_mensal = $1,
        ia_custo_limite_mensal = $2,
        assinatura_status = COALESCE($3, assinatura_status),
        ia_ativo = COALESCE($4, ia_ativo),
        ia_provider = COALESCE($5, ia_provider)
      WHERE id = $6
      `,
      [
        Math.max(0, Number(body.ia_limite_mensal || 0)),
        Math.max(0, Number(body.ia_custo_limite_mensal || 0)),
        body.assinatura_status || null,
        typeof body.ia_ativo === "boolean" ? body.ia_ativo : null,
        providerValido,
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
        u.nome,
        u.sobrenome,
        u.plano,
        u.plano_ativado_em,
        u.assinatura_status,
        u.assinatura_inicio,
        u.ia_limite_mensal,
        u.ia_custo_limite_mensal,
        COALESCE(u.ia_ativo, true) AS ia_ativo,
        u.admin_id,
        admin.email AS admin_email,
        COALESCE(u.is_parceiro, false) AS is_parceiro,
        u.parceiro_id,
        parceiro.email AS parceiro_email,
        COALESCE(u.ativo, true) AS ativo,
        COALESCE(ia.uso_mes, 0) AS ia_uso_mes,
        COALESCE(ia.custo_mes, 0) AS ia_custo_mes,
        COUNT(DISTINCT c.id) AS campanhas,
        COUNT(DISTINCT l.id) AS leads,
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'id',   n.id,
              'slug', n.slug,
              'nome', n.nome,
              'cor',  n.cor
            ) ORDER BY n.id)
            FROM usuario_nichos un
            INNER JOIN nichos n ON n.id = un.nicho_id
            WHERE un.usuario_id = u.id
          ),
          '[]'::json
        ) AS nichos
      FROM usuarios u
      LEFT JOIN usuarios admin
        ON admin.id = u.admin_id
      LEFT JOIN usuarios parceiro
        ON parceiro.id = u.parceiro_id
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
        u.nome,
        u.sobrenome,
        u.plano,
        u.plano_ativado_em,
        u.assinatura_status,
        u.assinatura_inicio,
        u.ia_limite_mensal,
        u.ia_custo_limite_mensal,
        u.ia_ativo,
        u.admin_id,
        admin.email,
        u.is_parceiro,
        u.parceiro_id,
        parceiro.email,
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


/* =========================
   🤝 FINANCEIRO DE PARCEIROS
========================= */

// 🔹 listar lançamentos (super_admin)
app.get("/admin/parceiro-financeiro", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    if (user.tipo !== "super_admin") {
      return c.json({
        error: "Acesso negado"
      }, 403);
    }

    const result = await client.query(`
      SELECT
        pf.id,
        pf.parceiro_id,
        parceiro.email AS parceiro_email,
        pf.cliente_id,
        cliente.email AS cliente_email,
        pf.mes_referencia,
        pf.plano,
        pf.valor_mensalidade,
        pf.valor_comissao,
        pf.percentual_parceiro,
        pf.status,
        pf.pago_em,
        pf.observacoes,
        pf.criado_em
      FROM parceiro_financeiro pf
      INNER JOIN usuarios parceiro
        ON parceiro.id = pf.parceiro_id
      INNER JOIN usuarios cliente
        ON cliente.id = pf.cliente_id
      ORDER BY pf.mes_referencia DESC, pf.id DESC
    `);

    return c.json({
      lancamentos: result.rows
    });

  } catch (err) {

    console.error("ERRO LISTAR FINANCEIRO PARCEIRO:", err);

    return c.json({
      error: "Erro ao buscar financeiro de parceiros"
    }, 500);
  }
});

// 🔹 criar/atualizar lançamento (super_admin)
app.post("/admin/parceiro-financeiro", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    if (user.tipo !== "super_admin") {
      return c.json({
        error: "Acesso negado"
      }, 403);
    }

    const body = await c.req.json();

    const {
      cliente_id,
      mes_referencia,
      plano,
      valor_total,
      percentual_parceiro,
      status,
      observacoes
    } = body;

    if (!cliente_id || !mes_referencia) {
      return c.json({
        error: "Cliente e mês de referência são obrigatórios"
      }, 400);
    }

    const cliente = await client.query(
      `
      SELECT id, parceiro_id
      FROM usuarios
      WHERE id = $1
      LIMIT 1
      `,
      [cliente_id]
    );

    const parceiroId = cliente.rows[0]?.parceiro_id;

    if (!parceiroId) {
      return c.json({
        error: "Este cliente não está vinculado a um parceiro"
      }, 400);
    }

    const valorTotal = Number(valor_total) || 0;
    const percentualParceiro =
      percentual_parceiro != null && percentual_parceiro !== ""
        ? Number(percentual_parceiro)
        : PARCEIRO_PERCENTUAL_COMISSAO * 100;
    const valorComissao = Math.round(
      valorTotal * (percentualParceiro / 100) * 100
    ) / 100;

    const result = await client.query(
      `
      INSERT INTO parceiro_financeiro (
        parceiro_id,
        cliente_id,
        mes_referencia,
        plano,
        valor_mensalidade,
        valor_comissao,
        percentual_parceiro,
        status,
        observacoes,
        pago_em
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        COALESCE($8, 'pendente'),
        $9,
        CASE WHEN $8 = 'pago' THEN NOW() ELSE NULL END
      )
      ON CONFLICT (cliente_id, mes_referencia)
      DO UPDATE SET
        plano = EXCLUDED.plano,
        valor_mensalidade = EXCLUDED.valor_mensalidade,
        valor_comissao = EXCLUDED.valor_comissao,
        percentual_parceiro = EXCLUDED.percentual_parceiro,
        status = EXCLUDED.status,
        observacoes = EXCLUDED.observacoes,
        pago_em = CASE
          WHEN EXCLUDED.status = 'pago' THEN COALESCE(parceiro_financeiro.pago_em, NOW())
          ELSE NULL
        END
      RETURNING id
      `,
      [
        parceiroId,
        cliente_id,
        mes_referencia,
        plano || null,
        valorTotal,
        valorComissao,
        percentualParceiro,
        status || "pendente",
        observacoes || null
      ]
    );

    return c.json({
      sucesso: true,
      id: result.rows[0].id
    });

  } catch (err) {

    console.error("ERRO SALVAR FINANCEIRO PARCEIRO:", err);

    return c.json({
      error: "Erro ao salvar lançamento"
    }, 500);
  }
});

// 🔹 atualizar status/valores de um lançamento (super_admin)
app.put("/admin/parceiro-financeiro/:id", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    if (user.tipo !== "super_admin") {
      return c.json({
        error: "Acesso negado"
      }, 403);
    }

    const id = Number(c.req.param("id"));

    const body = await c.req.json();

    const {
      plano,
      valor_total,
      percentual_parceiro,
      status,
      observacoes
    } = body;

    let valorComissao = null;

    if (valor_total != null || percentual_parceiro != null) {
      const atual = await client.query(
        `SELECT valor_mensalidade, percentual_parceiro FROM parceiro_financeiro WHERE id = $1`,
        [id]
      );

      const valorTotal =
        valor_total != null
          ? Number(valor_total)
          : Number(atual.rows[0]?.valor_mensalidade) || 0;

      const percentualParceiro =
        percentual_parceiro != null && percentual_parceiro !== ""
          ? Number(percentual_parceiro)
          : Number(atual.rows[0]?.percentual_parceiro) || (PARCEIRO_PERCENTUAL_COMISSAO * 100);

      valorComissao = Math.round(valorTotal * (percentualParceiro / 100) * 100) / 100;
    }

    await client.query(
      `
      UPDATE parceiro_financeiro
      SET
        plano = COALESCE($1, plano),
        valor_mensalidade = COALESCE($2, valor_mensalidade),
        valor_comissao = COALESCE($3, valor_comissao),
        percentual_parceiro = COALESCE($4, percentual_parceiro),
        status = COALESCE($5, status),
        observacoes = COALESCE($6, observacoes),
        pago_em = CASE
          WHEN $5 = 'pago' THEN COALESCE(pago_em, NOW())
          WHEN $5 = 'pendente' THEN NULL
          ELSE pago_em
        END
      WHERE id = $7
      `,
      [
        plano,
        valor_total,
        valorComissao,
        percentual_parceiro,
        status,
        observacoes,
        id
      ]
    );

    return c.json({
      sucesso: true
    });

  } catch (err) {

    console.error("ERRO ATUALIZAR FINANCEIRO PARCEIRO:", err);

    return c.json({
      error: "Erro ao atualizar lançamento"
    }, 500);
  }
});

// 🔹 excluir lançamento (super_admin)
app.delete("/admin/parceiro-financeiro/:id", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    if (user.tipo !== "super_admin") {
      return c.json({
        error: "Acesso negado"
      }, 403);
    }

    const id = Number(c.req.param("id"));

    await client.query(
      `
      DELETE FROM parceiro_financeiro
      WHERE id = $1
      `,
      [id]
    );

    return c.json({
      sucesso: true
    });

  } catch (err) {

    console.error("ERRO EXCLUIR FINANCEIRO PARCEIRO:", err);

    return c.json({
      error: "Erro ao excluir lançamento"
    }, 500);
  }
});

// 🔹 painel do parceiro (somente leitura)
app.get("/parceiro/painel", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

    if (!user.is_parceiro && user.tipo !== "super_admin") {
      return c.json({
        error: "Acesso restrito a parceiros"
      }, 403);
    }

    const clientes = await client.query(
      `
      SELECT
        id,
        email,
        nome,
        sobrenome,
        tipo,
        plano,
        COALESCE(ativo, true) AS ativo
      FROM usuarios
      WHERE parceiro_id = $1
      ORDER BY email ASC
      `,
      [user.id]
    );

    const lancamentos = await client.query(
      `
      SELECT
        pf.id,
        pf.cliente_id,
        cliente.email AS cliente_email,
        pf.mes_referencia,
        pf.plano,
        pf.valor_mensalidade,
        pf.valor_comissao,
        pf.percentual_parceiro,
        pf.status,
        pf.pago_em,
        pf.observacoes
      FROM parceiro_financeiro pf
      INNER JOIN usuarios cliente
        ON cliente.id = pf.cliente_id
      WHERE pf.parceiro_id = $1
      ORDER BY pf.mes_referencia DESC, pf.id DESC
      `,
      [user.id]
    );

    return c.json({
      clientes: clientes.rows,
      lancamentos: lancamentos.rows
    });

  } catch (err) {

    console.error("ERRO PAINEL PARCEIRO:", err);

    return c.json({
      error: "Erro ao carregar painel do parceiro"
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
      Number(usoIA.usage?.output_tokens || 0),
      usoIA.provider || "openai"
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
          email,
          status,
          campanha,
          observacao,
          motivo_perda,
          score,
          score_manual,
          data_contato,
          observacao_agendamento,
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
    const leadsContexto =
      leads.map((lead: any) => ({
        id: lead.id,
        nome: lead.nome || null,
        telefone: lead.telefone || null,
        email: lead.email || null,
        status: lead.status || null,
        campanha: lead.campanha || null,
        motivo_perda: lead.motivo_perda || null,
        observacao: lead.observacao || null,
        score: lead.score_manual || lead.score || null,
        data_contato: lead.data_contato || null,
        observacao_agendamento: lead.observacao_agendamento || null,
        criado_em: lead.criado_em
      }));

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
        "Criar uma campanha de reativacao em lote usando os dados reais de cada lead. Gere mensagens diferentes por perfil, mencione campanha, observacao ou motivo de perda somente quando existir nos dados. Nao invente nomes, campanhas ou interesses. Priorize leads com telefone, perda reversivel, contato antigo ou score mais quente.",
        {
          total_leads: leadsContexto.length,
          leads: leadsContexto
        },
        fallback,
        (user as any).ia_provider || "auto"
      );

    if (usoIA.provider === "fallback") {
      return c.json({
        error: "Nenhuma IA configurada respondeu agora. Verifique OpenAI/Anthropic no painel administrativo."
      }, 503);
    }

    await registrarUsoIA(
      Number(user.id),
      "reativacao_lote",
      "lead_lote",
      ids.join(","),
      usoIA.custo_estimado,
      Number(usoIA.usage?.input_tokens || 0),
      Number(usoIA.usage?.output_tokens || 0),
      usoIA.provider || "openai"
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
    const periodoParam =
      String(c.req.query("periodo") || "diario")
        .toLowerCase();

    const periodo =
      ["diario", "semanal", "mensal"].includes(periodoParam)
        ? periodoParam
        : "diario";

    const diasPeriodo =
      periodo === "mensal"
        ? 30
        : periodo === "semanal"
        ? 7
        : 1;

    const tituloPeriodo =
      periodo === "mensal"
        ? "Resumo mensal"
        : periodo === "semanal"
        ? "Resumo semanal"
        : "Resumo diario";

    const focoPeriodo =
      periodo === "mensal"
        ? "do mes"
        : periodo === "semanal"
        ? "da semana"
        : "de hoje";

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
          email,
          status,
          campanha,
          observacao,
          score,
          score_manual,
          motivo_perda,
          data_contato,
          observacao_agendamento,
          criado_em
        FROM leads
        WHERE usuario_id = $1
        AND criado_em >= NOW() - ($2::int * INTERVAL '1 day')
        ORDER BY criado_em DESC
        LIMIT 80
        `,
        [user.id, diasPeriodo]
      );

    const leads =
      leadsResult.rows;
    const leadsContexto =
      leads.map((lead: any) => ({
        id: lead.id,
        nome: lead.nome || null,
        telefone: lead.telefone || null,
        email: lead.email || null,
        status: lead.status || null,
        campanha: lead.campanha || null,
        observacao: lead.observacao || null,
        motivo_perda: lead.motivo_perda || null,
        score: lead.score_manual || lead.score || null,
        data_contato: lead.data_contato || null,
        observacao_agendamento: lead.observacao_agendamento || null,
        criado_em: lead.criado_em
      }));
    const totaisPorStatus =
      leadsContexto.reduce((acc: Record<string, number>, lead: any) => {
        const status =
          String(lead.status || "sem_status");
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, {});
    const fallback =
      sugestaoIAFallback(
        `${tituloPeriodo} IA Ouro`,
        `Priorize leads ${focoPeriodo}, quentes e parados ha mais tempo.`,
        `Focar nos 5 leads com maior chance de conversa ${focoPeriodo}.`,
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
        `Gerar ${tituloPeriodo.toLowerCase()} inteligente do corretor. Analise os leads reais ${focoPeriodo}, escolha ate 5 prioridades e explique por que cada uma merece atencao. Considere status, score, campanha, observacao, motivo de perda, telefone, data de criacao e agendamento. Nao invente leads nem use placeholders como "Nome do Lead". Se houver poucos dados, seja transparente e recomende acoes praticas.`,
        {
          periodo,
          dias_periodo: diasPeriodo,
          total_leads: leadsContexto.length,
          totais_por_status: totaisPorStatus,
          leads: leadsContexto
        },
        fallback,
        (user as any).ia_provider || "auto"
      );

    if (usoIA.provider === "fallback") {
      return c.json({
        error: "Nenhuma IA configurada respondeu agora. Verifique OpenAI/Anthropic no painel administrativo."
      }, 503);
    }

    await registrarUsoIA(
      Number(user.id),
      `resumo_${periodo}`,
      "usuario",
      user.id,
      usoIA.custo_estimado,
      Number(usoIA.usage?.input_tokens || 0),
      Number(usoIA.usage?.output_tokens || 0),
      usoIA.provider || "openai"
    );

    return c.json({
      periodo,
      dias_periodo: diasPeriodo,
      sugestao: usoIA.sugestao
    });
  } catch (err) {
    console.error("ERRO IA RESUMO DIARIO:", err);
    return c.json({ error: "Erro ao gerar resumo diario com IA" }, 500);
  }
});

app.post("/ia/campanhas/criador", authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const contexto = textoOpcional(body.contexto) || "";
  const nicho: string = textoOpcional(body.campanha?.nicho) || textoOpcional(body.nicho) || "imoveis";

  const nichoConfig: Record<string, {
    topicoDefault: string;
    especialidade: string;
    v1titulo: string; v1texto: string;
    v2titulo: string; v2texto: string;
    v3titulo: string; v3texto: string;
    perguntas: string;
    interesses: string;
    idadeMin: string; idadeMax: string;
    obrigadoTextoSufixo: string;
  }> = {
    imoveis: {
      topicoDefault: "imovel imobiliario",
      especialidade: "imoveis no Brasil",
      v1titulo: "Ultimas unidades! Reserve hoje mesmo",
      v1texto: "crie senso de urgencia, medo de perder a oportunidade",
      v2titulo: "Sua familia merece um lar assim",
      v2texto: "evoque emocao, sonho realizado, qualidade de vida",
      v3titulo: "Localizacao + seguranca + conforto",
      v3texto: "destaque beneficios concretos e diferenciais especificos",
      perguntas: "Qual regiao voce procura?\nQual faixa de investimento?\nPretende financiar?",
      interesses: "imoveis, casa propria, financiamento imobiliario, apartamento",
      idadeMin: "25", idadeMax: "55",
      obrigadoTextoSufixo: "nosso corretor vai entrar em contato"
    },
    saude: {
      topicoDefault: "plano de saude",
      especialidade: "planos de saude no Brasil",
      v1titulo: "Sua saude nao pode esperar",
      v1texto: "crie urgencia em torno da importancia de estar protegido, risco de ficar sem plano",
      v2titulo: "Cuide de quem voce ama com o plano certo",
      v2texto: "evoque emocao, protecao da familia, tranquilidade e seguranca",
      v3titulo: "Cobertura completa, preco justo",
      v3texto: "destaque beneficios concretos: rede credenciada, sem carencia, preco acessivel",
      perguntas: "Voce possui plano de saude atualmente?\nQuantas pessoas seriam incluidas no plano?\nQual regiao voce mora?",
      interesses: "plano de saude, saude e bem-estar, convenio medico, seguro saude, consulta medica",
      idadeMin: "22", idadeMax: "60",
      obrigadoTextoSufixo: "nosso consultor vai apresentar as melhores opcoes de plano"
    },
    suplementos: {
      topicoDefault: "suplemento alimentar",
      especialidade: "suplementos e nutricao esportiva no Brasil",
      v1titulo: "Resultados reais em menos tempo",
      v1texto: "crie urgencia em torno de evolucao fisica, estoque limitado ou promocao por tempo limitado",
      v2titulo: "Seu corpo merece o melhor combustivel",
      v2texto: "evoque motivacao, transformacao corporal, superacao de limites",
      v3titulo: "Qualidade comprovada, entrega rapida",
      v3texto: "destaque composicao, pureza, certificacoes e diferencial do produto",
      perguntas: "Qual e seu principal objetivo: ganho de massa ou emagrecimento?\nVoce ja usa suplementos atualmente?\nCom que frequencia voce treina?",
      interesses: "musculacao, fitness, suplementacao, treino, academia, nutricao esportiva, whey protein",
      idadeMin: "18", idadeMax: "45",
      obrigadoTextoSufixo: "nossa equipe vai te ajudar a escolher o suplemento ideal"
    },
    saas: {
      topicoDefault: "plataforma de gestao de leads",
      especialidade: "software SaaS, plataformas digitais e ferramentas para vendas e marketing no Brasil",
      v1titulo: "Pare de perder leads por falta de organizacao",
      v1texto: "crie urgencia em torno do prejuizo financeiro de perder leads por desorganizacao, enfatize quanto dinheiro e desperdicado sem uma ferramenta adequada",
      v2titulo: "Imagine saber exatamente qual campanha trouxe cada cliente",
      v2texto: "evoque o desejo de controle total, clareza nos resultados e crescimento previsivel do negocio",
      v3titulo: "IA + Meta Ads + CRM em uma so plataforma",
      v3texto: "destaque diferenciais tecnicos: integracao com Meta, IA para criar campanhas, gestao de leads automatica e custo por lead visivel em tempo real",
      perguntas: "Voce ja anuncia no Facebook ou Instagram?\nComo voce organiza seus leads hoje?\nQuantos leads voce recebe por mes em media?",
      interesses: "marketing digital, gestao de leads, Facebook Ads, CRM, vendas online, automacao de marketing, empreendedorismo",
      idadeMin: "25", idadeMax: "55",
      obrigadoTextoSufixo: "nossa equipe vai te mostrar como a plataforma pode transformar seus resultados"
    }
  };

  const cfg = nichoConfig[nicho] || nichoConfig["imoveis"];
  const topico = contexto || cfg.topicoDefault;

  const fallbackVariacoes = (t: string) =>
    [1, 2, 3].map(() => ({
      titulo: t.slice(0, 40),
      nome_campanha: t.slice(0, 40),
      texto: `Conheca ${t}. Atendimento rapido e personalizado.`,
      descricao: `${t} com atendimento especializado.`,
      cta: "SIGN_UP",
      perguntas: cfg.perguntas,
      interesses: cfg.interesses,
      localidade: "",
      genero: "",
      idade_min: cfg.idadeMin,
      idade_max: cfg.idadeMax,
      obrigado_titulo: "Recebemos seu contato!",
      obrigado_botao: "Ver mais",
      obrigado_texto: `Em breve ${cfg.obrigadoTextoSufixo}.`,
      nicho_tipo_imovel: "",
      nicho_finalidade: "",
      nicho_valor_min: "",
      nicho_valor_max: "",
      nicho_operadora: "",
      nicho_tipo_plano: "",
      nicho_cobertura: "",
      nicho_acomodacao: "",
      nicho_produto: "",
      nicho_objetivo: "",
      nicho_marca: "",
      nicho_publico_alvo: "",
      cbo: true,
      attribution_spec: "7d_click_1d_view"
    }));

  const norm = (v: any, ctaDefault: string) => {
    const titulo =
      v?.titulo || v?.nome_campanha || topico.slice(0, 40);

    return {
      nome_campanha: titulo,
      titulo,
      texto: v?.texto || "",
      descricao: v?.descricao || "",
      cta: v?.cta || ctaDefault,
      perguntas: v?.perguntas || "",
      interesses: v?.interesses || "",
      localidade: v?.localidade || "",
      genero: v?.genero || "",
      idade_min: String(v?.idade_min || cfg.idadeMin),
      idade_max: String(v?.idade_max || cfg.idadeMax),
      obrigado_titulo: v?.obrigado_titulo || "Recebemos seu contato!",
      obrigado_botao: v?.obrigado_botao || "Ver mais",
      obrigado_texto: v?.obrigado_texto || `Em breve entraremos em contato sobre ${topico}.`,
      nicho_tipo_imovel: v?.nicho_tipo_imovel || v?.tipo_imovel || "",
      nicho_finalidade: v?.nicho_finalidade || v?.finalidade || "",
      nicho_valor_min: v?.nicho_valor_min || v?.valor_min || "",
      nicho_valor_max: v?.nicho_valor_max || v?.valor_max || "",
      nicho_operadora: v?.nicho_operadora || v?.operadora || "",
      nicho_tipo_plano: v?.nicho_tipo_plano || v?.tipo_plano || "",
      nicho_cobertura: v?.nicho_cobertura || v?.cobertura || "",
      nicho_acomodacao: v?.nicho_acomodacao || v?.acomodacao || "",
      nicho_produto: v?.nicho_produto || v?.produto || "",
      nicho_objetivo: v?.nicho_objetivo || v?.objetivo_nicho || "",
      nicho_marca: v?.nicho_marca || v?.marca || "",
      nicho_publico_alvo: v?.nicho_publico_alvo || v?.publico_alvo || "",
      cbo: v?.cbo ?? true,
      attribution_spec: v?.attribution_spec || "7d_click_1d_view"
    };
  };

  const parseSugestoes = (texto: string) => {
    const limpo = texto
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(limpo);
    return [
      norm(parsed.v1 || parsed.variacao_1, "SIGN_UP"),
      norm(parsed.v2 || parsed.variacao_2, "LEARN_MORE"),
      norm(parsed.v3 || parsed.variacao_3, "APPLY_NOW")
    ];
  };

  try {
    const user: any = c.get("user");
    const limite = limitarRequisicao(c, `ia:${user.id}`, 20, 60 * 1000);
    if (limite) return limite;

    const bloqueio = await motivoBloqueioIA(user);
    if (bloqueio) return c.json({ error: bloqueio }, 403);

    const prompt =
      `Produto/servico: "${topico}"\n` +
      `Nicho: ${cfg.especialidade}\n\n` +
      `Crie 3 anuncios Meta Ads com estilos COMPLETAMENTE DIFERENTES para captar leads desse produto.\n\n` +
      `REGRAS OBRIGATORIAS:\n` +
      `1. O titulo NUNCA pode ser o nome do produto. Deve ser uma frase de impacto.\n` +
      `2. PROIBIDO usar: "Conheca X", "Atendimento rapido e personalizado", "com atendimento especializado".\n` +
      `3. Cada variacao deve ter titulo, texto e descricao totalmente diferentes das outras.\n` +
      `4. Use os detalhes especificos do produto e do nicho para criar copy relevante e unico.\n\n` +
      `v1 — URGENCIA E ESCASSEZ:\n` +
      `  Titulo exemplo: "${cfg.v1titulo}"\n` +
      `  Texto: ${cfg.v1texto}\n` +
      `  cta: SIGN_UP\n\n` +
      `v2 — EMOCIONAL:\n` +
      `  Titulo exemplo: "${cfg.v2titulo}"\n` +
      `  Texto: ${cfg.v2texto}\n` +
      `  cta: LEARN_MORE\n\n` +
      `v3 — RACIONAL E OBJETIVO:\n` +
      `  Titulo exemplo: "${cfg.v3titulo}"\n` +
      `  Texto: ${cfg.v3texto}\n` +
      `  cta: APPLY_NOW\n\n` +
      `Campos de cada variacao:\n` +
      `nome_campanha (igual ao titulo), titulo (max 40 chars), texto (2-3 frases), descricao (1 frase curta),\n` +
      `cta, perguntas (3 qualificadoras separadas por \\n), interesses (keywords separados por virgula),\n` +
      `localidade (regiao do produto ou vazio), genero (vazio), idade_min, idade_max,\n` +
      `obrigado_titulo, obrigado_botao, obrigado_texto,\n` +
      `cbo (true se houver multiplos publicos para testar, false para campanha simples),\n` +
      `attribution_spec (janela de atribuicao recomendada: "1d_click", "7d_click", "28d_click", "1d_click_1d_view", "7d_click_1d_view" — use "7d_click_1d_view" como padrao).\n\n` +
      `Campos opcionais de nicho: preencha SOMENTE se o contexto do usuario trouxer a informacao de forma clara.\n` +
      `Para imoveis: nicho_tipo_imovel (residencial|comercial|rural), nicho_finalidade (venda|locacao), nicho_valor_min, nicho_valor_max.\n` +
      `Para saude: nicho_operadora, nicho_tipo_plano (individual|familiar|empresarial), nicho_cobertura (basica|intermediaria|premium), nicho_acomodacao (enfermaria|apartamento).\n` +
      `Para suplementos: nicho_produto (whey|creatina|pre_workout|bcaa|multivitaminico|colageno|outro), nicho_objetivo (ganho_massa|emagrecimento|performance|saude), nicho_marca, nicho_publico_alvo (iniciantes|intermediario|avancado).\n` +
      `Se o usuario informou esses detalhes, use-os nos 3 conteudos e tambem nos campos opcionais de nicho. Se nao informou, deixe vazio.\n\n` +
      `Retorne SOMENTE JSON valido sem texto antes ou depois:\n` +
      `{"v1":{...todos os campos...},"v2":{...},"v3":{...}}`;

    const systemMsg =
      `Voce e um redator publicitario criativo especializado em Meta Ads para ${cfg.especialidade}. ` +
      "Escreva copy persuasivo, especifico e distinto para cada variacao de anuncio. " +
      "NUNCA use frases genericas. Use os detalhes do produto para criar mensagens unicas. " +
      "Retorne SOMENTE JSON valido.";

    const iaProvider: string = (user as any).ia_provider || "auto";
    const openaiKey = Bun.env.OPENAI_API_KEY;
    const anthropicKey = Bun.env.ANTHROPIC_API_KEY;

    const iaConf = await client.query(
      "SELECT modelo, anthropic_modelo FROM ia_config WHERE id = 1 LIMIT 1"
    );

    const tentarOpenAI = async () => {
      if (!openaiKey) return null;
      try {
        const modelo =
          textoOpcional(iaConf.rows[0]?.modelo) ||
          textoOpcional(Bun.env.OPENAI_MODEL) ||
          "gpt-5-mini";

        const usarResponsesAPI =
          modelo.startsWith("gpt-5") ||
          modelo.startsWith("o1") ||
          modelo.startsWith("o3") ||
          modelo.startsWith("o4");

        const respBody = usarResponsesAPI
          ? {
              model: modelo,
              temperature: 1.0,
              instructions: systemMsg,
              input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }]
            }
          : {
              model: modelo,
              temperature: 1.0,
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: systemMsg },
                { role: "user", content: prompt }
              ]
            };

        const resp = await fetch(
          usarResponsesAPI ? OPENAI_RESPONSES_URL : "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(respBody)
          }
        );

        const data: any = await resp.json();

        if (!resp.ok) {
          console.error("CRIADOR CAMPANHA OPENAI ERROR:", data?.error?.message, "| model:", modelo);
          return null;
        }

        const textoResposta: string = usarResponsesAPI
          ? extrairTextoRespostaOpenAI(data)
          : (data?.choices?.[0]?.message?.content || "");

        if (!textoResposta) return null;

        const sugestoes = parseSugestoes(textoResposta);
        const usageNorm = {
          input_tokens: Number(data?.usage?.input_tokens || data?.usage?.prompt_tokens || 0),
          output_tokens: Number(data?.usage?.output_tokens || data?.usage?.completion_tokens || 0)
        };
        const custo = calcularCustoEstimadoOpenAI(usageNorm);
        await registrarUsoIA(Number(user.id), "criador_campanha", "campanha", null, custo, usageNorm.input_tokens, usageNorm.output_tokens);
        return { sugestoes, _origem: "openai" };
      } catch (err) {
        console.error("CRIADOR CAMPANHA OPENAI EXCEPTION:", err);
        return null;
      }
    };

    const tentarAnthropic = async () => {
      if (!anthropicKey) return null;
      try {
        const respAnthropic = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: textoOpcional(iaConf.rows[0]?.anthropic_modelo) || "claude-haiku-4-5-20251001",
            max_tokens: 2048,
            system: systemMsg,
            messages: [{ role: "user", content: prompt }]
          })
        });

        const dataAnthropic: any = await respAnthropic.json();

        if (!respAnthropic.ok) {
          console.error("CRIADOR CAMPANHA ANTHROPIC ERROR:", dataAnthropic?.error?.message);
          return null;
        }

        const textoAnthropic: string = dataAnthropic?.content?.[0]?.text || "";
        if (!textoAnthropic) return null;

        const sugestoes = parseSugestoes(textoAnthropic);
        const inTok = Number(dataAnthropic?.usage?.input_tokens || 0);
        const outTok = Number(dataAnthropic?.usage?.output_tokens || 0);
        const custoAnthropic = calcularCustoEstimadoAnthropic({ input_tokens: inTok, output_tokens: outTok });
        await registrarUsoIA(Number(user.id), "criador_campanha", "campanha", null, custoAnthropic, inTok, outTok, "anthropic");
        return { sugestoes, _origem: "anthropic" };
      } catch (err) {
        console.error("CRIADOR CAMPANHA ANTHROPIC EXCEPTION:", err);
        return null;
      }
    };

    // ── Executa conforme provider do usuario ──────────────────────
    let resultado: { sugestoes: any[]; _origem: string } | null = null;

    if (iaProvider === "openai") {
      resultado = await tentarOpenAI();
    } else if (iaProvider === "anthropic") {
      resultado = await tentarAnthropic();
    } else {
      // auto: tenta OpenAI, fallback para Anthropic
      resultado = await tentarOpenAI() ?? await tentarAnthropic();
    }

    if (resultado) return c.json(resultado);

    // ── Sem IA disponivel ─────────────────────────────────────────
    return c.json({
      sugestoes: fallbackVariacoes(topico),
      _origem: "sem_chave"
    });

  } catch (err) {
    console.error("CRIADOR CAMPANHA ERRO:", err);
    return c.json({ sugestoes: fallbackVariacoes(topico) });
  }
});

app.post("/ia/gerar-banner", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const limite = limitarRequisicao(c, `ia-banner:${user.id}`, 5, 60 * 1000);
    if (limite) return limite;

    const bloqueio = await motivoBloqueioIA(user);
    if (bloqueio) return c.json({ error: bloqueio }, 403);

    const body = await c.req.json().catch(() => ({}));
    const prompt = textoOpcional(body.prompt);
    if (!prompt) return c.json({ error: "Descreva o banner antes de gerar." }, 400);

    const modoEditar: boolean = body.modo === "editar";

    const imagensBase64: Array<{ data: string; tipo: string }> = Array.isArray(body.imagens_base64)
      ? body.imagens_base64.slice(0, modoEditar ? 1 : 4)
      : [];

    // Respeita o provider do usuário — geração de imagem só é suportada pela OpenAI,
    // então Anthropic faz fallback silencioso para OpenAI.
    const iaProvider: string = (user as any).ia_provider || "auto";
    const openaiKey = iaProvider === "anthropic"
      ? (Bun.env.OPENAI_API_KEY ?? null)   // fallback silencioso
      : Bun.env.OPENAI_API_KEY;

    if (!openaiKey) return c.json({ error: "Geração de imagem não configurada. Configure a chave OpenAI." }, 400);

    let imagemBase64 = "";

    if (imagensBase64.length > 0) {
      const formData = new FormData();
      formData.append("model", "gpt-image-1");
      formData.append("n", "1");
      formData.append("size", "1024x1024");
      formData.append("output_format", "png");

      if (modoEditar && imagensBase64.length === 1) {
        // Modo editar: prompt instrui o modelo a manter a imagem base e só modificar o solicitado
        const promptEdicao = `Editing task on the provided image: ${prompt}

IMPORTANT: Use the provided reference image as the exact visual base. Keep ALL original elements, colors, composition, and style. Only add, modify, or remove exactly what is described above. Do NOT recreate the image from scratch. The result must look like a natural modification of the original image.`;
        formData.append("prompt", promptEdicao);

        const { data, tipo } = imagensBase64[0];
        const buffer = Buffer.from(data, "base64");
        const blob = new Blob([buffer], { type: tipo || "image/png" });
        formData.append("image", blob, "base.png");
      } else {
        // Modo gerar com referências visuais
        formData.append("prompt", prompt);
        for (let i = 0; i < imagensBase64.length; i++) {
          const { data, tipo } = imagensBase64[i];
          const buffer = Buffer.from(data, "base64");
          const blob = new Blob([buffer], { type: tipo || "image/png" });
          formData.append("image", blob, `ref_${i + 1}.png`);
        }
      }

      const resp = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { "Authorization": `Bearer ${openaiKey}` },
        body: formData
      });

      const result: any = await resp.json();
      if (!resp.ok) {
        console.error("GERAR BANNER GPT-IMAGE-1 ERROR:", result?.error?.message);
        return c.json({ error: result?.error?.message || "Erro ao gerar banner com as imagens selecionadas." }, 500);
      }
      imagemBase64 = result?.data?.[0]?.b64_json || "";
    } else {
      // Usa gpt-image-1 somente com texto
      const resp = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openaiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt,
          n: 1,
          size: "1024x1024",
          output_format: "png"
        })
      });

      const result: any = await resp.json();
      if (!resp.ok) {
        console.error("GERAR BANNER GPT-IMAGE-1 TEXT ERROR:", result?.error?.message);
        return c.json({ error: result?.error?.message || "Erro ao gerar banner." }, 500);
      }
      imagemBase64 = result?.data?.[0]?.b64_json || "";
    }

    if (!imagemBase64) return c.json({ error: "A IA não retornou uma imagem. Tente novamente." }, 500);

    await registrarUsoIA(Number(user.id), "gerar_banner", "imagem", null, 0, 0, 0);

    return c.json({ sucesso: true, imagem_base64: imagemBase64 });
  } catch (err) {
    console.error("GERAR BANNER EXCEPTION:", err);
    return c.json({ error: "Erro interno ao gerar banner." }, 500);
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
      Number(usoIA.usage?.output_tokens || 0),
      usoIA.provider || "openai"
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
        limite_alerta_usd = COALESCE($8, limite_alerta_usd),
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
        body.observacoes ?? null,
        body.limite_alerta_usd === undefined
          ? null
          : Number(body.limite_alerta_usd)
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
      plano,
      nicho_ids,
      whatsapp
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

    const novoUsuario = await client.query(
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
        assinatura_status,
        whatsapp
      )
      VALUES (
        $1,$2,$3,$4,$5,true,$6,$7,
        CASE WHEN $7 = 'ouro' THEN NOW() ELSE NULL END,
        CASE WHEN $7 = 'ouro' THEN NOW() ELSE NULL END,
        CASE WHEN $7 = 'ouro' THEN 'manual' ELSE 'manual' END,
        $8
      )
      RETURNING id
      `,
      [
        nome,
        sobrenome,
        email,
        senhaHash,
        tipo || "corretor",
        admin_id || null,
        planoFinal,
        whatsapp ? String(whatsapp).replace(/\D/g, "").slice(0, 20) : null
      ]
    );

    const novoId = novoUsuario.rows[0].id;

    if (Array.isArray(nicho_ids) && nicho_ids.length > 0) {
      for (const nid of nicho_ids.slice(0, 3)) {
        await client.query(
          `INSERT INTO usuario_nichos (usuario_id, nicho_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [novoId, nid]
        );
      }
    }

    return c.json({
      sucesso: true,
      id: novoId
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



// 🔄 AUTO SYNC A CADA 4 HORAS (com delay de 2s entre usuários para não sobrecarregar a Meta API)
setInterval(() => {
  sincronizarTodasCampanhas();
}, 1000 * 60 * 60 * 4);


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
  const mensagemSegura =
    escaparHtmlEmail(mensagem.trim());
  const emailUsuario =
    escaparHtmlEmail(user.email);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${Bun.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: PLATAFORMA_FROM_EMAIL,
      to: FEEDBACK_DESTINO_EMAIL,
      reply_to: user.email,
      subject: `${tipoLabel} — Plataforma de Leads`,
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;max-width:560px;">
          <h2 style="margin-bottom:4px;">${tipoLabel}</h2>
          <p style="color:#6b7280;font-size:13px;margin-top:0;">Plataforma de Leads</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
          <p><strong>De:</strong> ${emailUsuario}</p>
          <p><strong>Tipo:</strong> ${tipoLabel}</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
          <p style="white-space:pre-wrap;">${mensagemSegura}</p>
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

  // Notifica admins via WhatsApp (só se suporte não estiver com a conversa aberta)
  try {
    const visto = await client.query(
      `SELECT suporte_visto_em FROM chat_conversas WHERE id = $1`,
      [conversaId]
    );
    const vistoEm = visto.rows[0]?.suporte_visto_em;
    const suporteAtivo = vistoEm && (Date.now() - new Date(vistoEm).getTime()) < 2 * 60 * 1000;

    if (!suporteAtivo) {
      const admins = await client.query(
        `SELECT whatsapp FROM usuarios WHERE tipo = 'super_admin' AND whatsapp IS NOT NULL AND whatsapp <> ''`
      );
      const nomeRemetente = `${user.nome || ""} ${user.sobrenome || ""}`.trim() || user.email;
      const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      const msgWpp = `🔔 *Plataforma de Leads — Nova mensagem*\n\n👤 *Cliente:* ${nomeRemetente}\n💬 *Mensagem:* ${conteudo.trim()}\n⏰ *Horário:* ${agora}\n\nAcesse o painel de suporte para responder.`;
      for (const admin of admins.rows) {
        await enviarLembreteWhatsApp(admin.whatsapp, msgWpp);
      }
    }
  } catch (e) {
    console.error("ERRO notif chat WhatsApp:", e);
  }

  return c.json({ sucesso: true, conversa_id: conversaId });
});

// Envia anexo (imagem/print/arquivo) no chat — usuário ou suporte
app.post("/chat/anexo", authMiddleware, async (c: any) => {
  const user: any = c.get("user");

  try {
    const body = await c.req.formData();
    const arquivo = body.get("arquivo") as File | null;
    const conteudo = String(body.get("conteudo") || "").trim();

    if (!arquivo) {
      return c.json({ error: "Arquivo não enviado" }, 400);
    }

    const TAMANHO_MAX = 8 * 1024 * 1024; // 8MB

    if (arquivo.size > TAMANHO_MAX) {
      return c.json({ error: "Arquivo muito grande (máximo 8MB)" }, 400);
    }

    const tiposPermitidos = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "application/pdf"
    ];

    if (!tiposPermitidos.includes(arquivo.type)) {
      return c.json({ error: "Tipo de arquivo não suportado" }, 400);
    }

    const buffer = await arquivo.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const anexoUrl = `data:${arquivo.type};base64,${base64}`;

    let conversaId: number;
    let remetenteTipo: string;

    if (isSuporte(user.tipo)) {

      remetenteTipo = "suporte";

      const conversaIdParam = body.get("conversa_id");
      const usuarioIdParam = body.get("usuario_id");

      if (conversaIdParam) {

        conversaId = Number(conversaIdParam);

        const conversa = await client.query(
          `SELECT status FROM chat_conversas WHERE id = $1 LIMIT 1`,
          [conversaId]
        );

        if (!conversa.rows.length) {
          return c.json({ error: "Conversa nao encontrada" }, 404);
        }

        if (conversa.rows[0].status === "fechada") {
          return c.json({ error: "Reabra a conversa antes de responder" }, 409);
        }

      } else if (usuarioIdParam) {

        const alvo = await client.query(
          `SELECT id FROM usuarios
           WHERE id = $1
           AND COALESCE(ativo, true) = true
           AND tipo NOT IN ('suporte', 'super_admin', 'master')
           LIMIT 1`,
          [Number(usuarioIdParam)]
        );

        if (!alvo.rows.length) {
          return c.json({ error: "Usuario nao encontrado" }, 404);
        }

        conversaId = await obterOuCriarConversaUsuario(Number(usuarioIdParam));

      } else {
        return c.json({ error: "Conversa ou usuario nao informado" }, 400);
      }

    } else {
      remetenteTipo = "usuario";
      conversaId = await obterOuCriarConversaUsuario(user.id);
    }

    await client.query(
      `INSERT INTO chat_mensagens (conversa_id, remetente_id, remetente_tipo, conteudo, anexo_url, anexo_tipo, anexo_nome)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [conversaId, user.id, remetenteTipo, conteudo, anexoUrl, arquivo.type, arquivo.name]
    );

    await client.query(
      `UPDATE chat_conversas SET status = 'aberta', atualizado_em = NOW() WHERE id = $1`,
      [conversaId]
    );

    return c.json({ sucesso: true, conversa_id: conversaId });

  } catch (err) {
    console.error("ERRO CHAT ANEXO:", err);
    return c.json({ error: "Erro ao enviar anexo" }, 500);
  }
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
    `SELECT id, remetente_tipo, conteudo, lido, enviado_em, anexo_url, anexo_tipo, anexo_nome
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
            u.id AS usuario_id, u.email AS usuario_email, u.nome AS usuario_nome,
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

// Suporte: todas as mensagens de um usuário (histórico unificado)
app.get("/chat/usuarios/:usuarioId/todas-mensagens", authMiddleware, async (c: any) => {
  const user: any = c.get("user");
  if (!isSuporte(user.tipo)) return c.json({ error: "Acesso negado" }, 403);

  const usuarioId = Number(c.req.param("usuarioId"));

  await client.query(
    `UPDATE chat_mensagens SET lido = TRUE
     WHERE conversa_id IN (SELECT id FROM chat_conversas WHERE usuario_id = $1)
     AND remetente_tipo = 'usuario' AND lido = FALSE`,
    [usuarioId]
  );

  const result = await client.query(
    `SELECT m.id, m.conteudo, m.remetente_tipo, m.enviado_em, m.lido,
            m.anexo_url, m.anexo_tipo, m.anexo_nome, cv.id AS conversa_id
     FROM chat_mensagens m
     JOIN chat_conversas cv ON cv.id = m.conversa_id
     WHERE cv.usuario_id = $1
     ORDER BY m.enviado_em ASC`,
    [usuarioId]
  );

  const convAtiva = await client.query(
    `SELECT id FROM chat_conversas
     WHERE usuario_id = $1 AND status = 'aberta'
     ORDER BY atualizado_em DESC LIMIT 1`,
    [usuarioId]
  );

  return c.json({
    mensagens: result.rows,
    conv_ativa_id: convAtiva.rows[0]?.id ?? null
  });
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
            m.anexo_url, m.anexo_tipo, m.anexo_nome,
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

// Marca conversa como visualizada pelo suporte (para não enviar WhatsApp desnecessário)
app.patch("/chat/conversas/:id/visualizar", authMiddleware, async (c: any) => {
  const user: any = c.get("user");
  if (!isSuporte(user.tipo)) return c.json({ error: "Acesso negado" }, 403);
  const id = Number(c.req.param("id"));
  await client.query(
    `UPDATE chat_conversas SET suporte_visto_em = NOW() WHERE id = $1`,
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
   🏷️ NICHOS
========================= */

// listar todos os nichos
app.get("/nichos", async (c) => {
  try {
    const result = await client.query(
      `SELECT id, slug, nome, cor FROM nichos ORDER BY id`
    );
    return c.json(result.rows);
  } catch (err) {
    console.error("ERRO GET /nichos:", err);
    return c.json({ error: "Erro ao buscar nichos" }, 500);
  }
});

// nichos habilitados do usuário autenticado
app.get("/usuario/nichos", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const result = await client.query(
      `SELECT n.id, n.slug, n.nome, n.cor
       FROM usuario_nichos un
       INNER JOIN nichos n ON n.id = un.nicho_id
       WHERE un.usuario_id = $1
       ORDER BY n.id`,
      [user.id]
    );
    return c.json(result.rows);
  } catch (err) {
    console.error("ERRO GET /usuario/nichos:", err);
    return c.json({ error: "Erro ao buscar nichos do usuário" }, 500);
  }
});

// atualizar nichos do usuário (substitui a lista)
app.put("/usuario/nichos", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const { nicho_ids } = await c.req.json();

    if (
      !Array.isArray(nicho_ids) ||
      nicho_ids.length === 0 ||
      nicho_ids.length > 4
    ) {
      return c.json(
        { error: "Informe entre 1 e 3 nichos" },
        400
      );
    }

    const validos = await client.query(
      `SELECT id FROM nichos WHERE id = ANY($1::int[])`,
      [nicho_ids]
    );

    if (validos.rows.length !== nicho_ids.length) {
      return c.json({ error: "Nicho inválido" }, 400);
    }

    await client.query(
      `DELETE FROM usuario_nichos WHERE usuario_id = $1`,
      [user.id]
    );

    for (const nid of nicho_ids) {
      await client.query(
        `INSERT INTO usuario_nichos (usuario_id, nicho_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [user.id, nid]
      );
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error("ERRO PUT /usuario/nichos:", err);
    return c.json({ error: "Erro ao atualizar nichos" }, 500);
  }
});

// nichos habilitados de outro usuário (admin)
app.get("/admin/usuarios/:id/nichos", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    if (user.tipo !== "super_admin") {
      return c.json({ error: "Acesso negado" }, 403);
    }
    const targetId = Number(c.req.param("id"));
    const result = await client.query(
      `SELECT n.id, n.slug, n.nome, n.cor
       FROM usuario_nichos un
       INNER JOIN nichos n ON n.id = un.nicho_id
       WHERE un.usuario_id = $1
       ORDER BY n.id`,
      [targetId]
    );
    return c.json(result.rows);
  } catch (err) {
    console.error("ERRO GET /admin/usuarios/:id/nichos:", err);
    return c.json({ error: "Erro ao buscar nichos" }, 500);
  }
});

// atualizar nichos de outro usuário (admin)
app.put("/admin/usuarios/:id/nichos", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    if (user.tipo !== "super_admin") {
      return c.json({ error: "Acesso negado" }, 403);
    }
    const targetId = Number(c.req.param("id"));
    const { nicho_ids } = await c.req.json();

    if (
      !Array.isArray(nicho_ids) ||
      nicho_ids.length === 0 ||
      nicho_ids.length > 4
    ) {
      return c.json(
        { error: "Informe entre 1 e 3 nichos" },
        400
      );
    }

    await client.query(
      `DELETE FROM usuario_nichos WHERE usuario_id = $1`,
      [targetId]
    );

    for (const nid of nicho_ids) {
      await client.query(
        `INSERT INTO usuario_nichos (usuario_id, nicho_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [targetId, nid]
      );
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error("ERRO PUT /admin/usuarios/:id/nichos:", err);
    return c.json({ error: "Erro ao atualizar nichos" }, 500);
  }
});

/* =============================================
   📋 CAMPANHAS MANUAIS (saúde / suplementos)
   e detalhes por nicho
============================================= */

// criar campanha manual (não-Meta) com dados do nicho
app.post("/campanhas/manual", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const body = await c.req.json();

    const {
      nome,
      nicho_id,
      // campos de imóveis
      tipo_imovel,
      finalidade,
      valor_min,
      valor_max,
      regiao,
      // campos de saúde
      operadora,
      tipo_plano,
      faixa_etaria_min,
      faixa_etaria_max,
      cobertura,
      acomodacao,
      // campos de suplementos
      produto,
      objetivo,
      marca,
      publico_alvo
    } = body;

    if (!nome) {
      return c.json({ error: "Nome obrigatório" }, 400);
    }

    if (!nicho_id) {
      return c.json({ error: "Nicho obrigatório" }, 400);
    }

    const nichoRes = await client.query(
      `SELECT slug FROM nichos WHERE id = $1`,
      [nicho_id]
    );
    if (nichoRes.rows.length === 0) {
      return c.json({ error: "Nicho inválido" }, 400);
    }
    const slug = nichoRes.rows[0].slug;

    const habilitado = await client.query(
      `SELECT 1 FROM usuario_nichos
       WHERE usuario_id = $1 AND nicho_id = $2`,
      [user.id, nicho_id]
    );
    if (habilitado.rows.length === 0) {
      return c.json(
        { error: "Você não tem esse nicho habilitado" },
        403
      );
    }

    const campRes = await client.query(
      `INSERT INTO campanhas (usuario_id, nome, status, origem, nicho_id)
       VALUES ($1, $2, 'ACTIVE', 'manual', $3)
       RETURNING id`,
      [user.id, nome, nicho_id]
    );
    const campanhaId = campRes.rows[0].id;

    if (slug === "imoveis") {
      await client.query(
        `INSERT INTO campanhas_imoveis
           (campanha_id, tipo_imovel, finalidade, valor_min, valor_max, regiao)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [campanhaId, tipo_imovel ?? null, finalidade ?? null,
         valor_min ?? null, valor_max ?? null, regiao ?? null]
      );
    } else if (slug === "saude") {
      await client.query(
        `INSERT INTO campanhas_saude
           (campanha_id, operadora, tipo_plano, faixa_etaria_min,
            faixa_etaria_max, cobertura, acomodacao)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [campanhaId, operadora ?? null, tipo_plano ?? null,
         faixa_etaria_min ?? null, faixa_etaria_max ?? null,
         cobertura ?? null, acomodacao ?? null]
      );
    } else if (slug === "suplementos") {
      await client.query(
        `INSERT INTO campanhas_suplementos
           (campanha_id, produto, objetivo, marca, publico_alvo)
         VALUES ($1, $2, $3, $4, $5)`,
        [campanhaId, produto ?? null, objetivo ?? null,
         marca ?? null, publico_alvo ?? null]
      );
    }

    return c.json({ id: campanhaId });
  } catch (err) {
    console.error("ERRO POST /campanhas/manual:", err);
    return c.json({ error: "Erro ao criar campanha" }, 500);
  }
});

// duplicar uma campanha existente
app.post("/campanhas/:id/duplicar", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const campanhaId = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => ({}));

    const origRes = await client.query(
      `SELECT c.*, n.slug AS nicho_slug
       FROM campanhas c
       LEFT JOIN nichos n ON n.id = c.nicho_id
       WHERE c.id = $1 AND c.usuario_id = $2`,
      [campanhaId, user.id]
    );

    if (origRes.rows.length === 0) {
      return c.json({ error: "Campanha não encontrada" }, 404);
    }

    const orig = origRes.rows[0];
    const novoNome = body.nome?.trim() || `Cópia de ${orig.nome}`;

    const novaRes = await client.query(
      `INSERT INTO campanhas
         (usuario_id, nome, status, origem, nicho_id, daily_budget, configuracoes_avancadas, conta_anuncios_id)
       VALUES ($1, $2, 'PAUSED', 'manual', $3, $4, $5, $6)
       RETURNING id`,
      [user.id, novoNome, orig.nicho_id ?? null, orig.daily_budget ?? null,
       orig.configuracoes_avancadas ?? null, orig.conta_anuncios_id ?? null]
    );
    const novaId = novaRes.rows[0].id;

    if (orig.nicho_slug === "imoveis") {
      const r = await client.query(
        `SELECT tipo_imovel, finalidade, valor_min, valor_max, regiao
         FROM campanhas_imoveis WHERE campanha_id = $1`,
        [campanhaId]
      );
      if (r.rows.length > 0) {
        const d = r.rows[0];
        await client.query(
          `INSERT INTO campanhas_imoveis
             (campanha_id, tipo_imovel, finalidade, valor_min, valor_max, regiao)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [novaId, d.tipo_imovel, d.finalidade, d.valor_min, d.valor_max, d.regiao]
        );
      }
    } else if (orig.nicho_slug === "saude") {
      const r = await client.query(
        `SELECT operadora, tipo_plano, faixa_etaria_min, faixa_etaria_max, cobertura, acomodacao
         FROM campanhas_saude WHERE campanha_id = $1`,
        [campanhaId]
      );
      if (r.rows.length > 0) {
        const d = r.rows[0];
        await client.query(
          `INSERT INTO campanhas_saude
             (campanha_id, operadora, tipo_plano, faixa_etaria_min,
              faixa_etaria_max, cobertura, acomodacao)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [novaId, d.operadora, d.tipo_plano, d.faixa_etaria_min,
           d.faixa_etaria_max, d.cobertura, d.acomodacao]
        );
      }
    } else if (orig.nicho_slug === "suplementos") {
      const r = await client.query(
        `SELECT produto, objetivo, marca, publico_alvo
         FROM campanhas_suplementos WHERE campanha_id = $1`,
        [campanhaId]
      );
      if (r.rows.length > 0) {
        const d = r.rows[0];
        await client.query(
          `INSERT INTO campanhas_suplementos
             (campanha_id, produto, objetivo, marca, publico_alvo)
           VALUES ($1, $2, $3, $4, $5)`,
          [novaId, d.produto, d.objetivo, d.marca, d.publico_alvo]
        );
      }
    }

    return c.json({ id: novaId });
  } catch (err) {
    console.error("ERRO POST /campanhas/:id/duplicar:", err);
    return c.json({ error: "Erro ao duplicar campanha" }, 500);
  }
});

// buscar detalhes do nicho de uma campanha
app.get("/campanhas/:id/nicho-dados", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const campanhaId = Number(c.req.param("id"));

    const campRes = await client.query(
      `SELECT c.id, c.nicho_id, n.slug, n.nome AS nicho_nome, n.cor AS nicho_cor
       FROM campanhas c
       LEFT JOIN nichos n ON n.id = c.nicho_id
       WHERE c.id = $1
         AND (c.usuario_id = $2 OR EXISTS (
           SELECT 1 FROM campanha_corretores cc
           WHERE cc.campanha_id = c.id AND cc.usuario_id = $2
         ))`,
      [campanhaId, user.id]
    );

    if (campRes.rows.length === 0) {
      return c.json({ error: "Campanha não encontrada" }, 404);
    }

    const camp = campRes.rows[0];
    let dados: any = null;

    if (camp.slug === "imoveis") {
      const r = await client.query(
        `SELECT * FROM campanhas_imoveis WHERE campanha_id = $1`,
        [campanhaId]
      );
      dados = r.rows[0] ?? null;
    } else if (camp.slug === "saude") {
      const r = await client.query(
        `SELECT * FROM campanhas_saude WHERE campanha_id = $1`,
        [campanhaId]
      );
      dados = r.rows[0] ?? null;
    } else if (camp.slug === "suplementos") {
      const r = await client.query(
        `SELECT * FROM campanhas_suplementos WHERE campanha_id = $1`,
        [campanhaId]
      );
      dados = r.rows[0] ?? null;
    }

    return c.json({
      nicho_id: camp.nicho_id,
      nicho_slug: camp.slug,
      nicho_nome: camp.nicho_nome,
      nicho_cor: camp.nicho_cor,
      dados
    });
  } catch (err) {
    console.error("ERRO GET /campanhas/:id/nicho-dados:", err);
    return c.json({ error: "Erro ao buscar dados do nicho" }, 500);
  }
});

// atualizar detalhes do nicho de uma campanha
app.put("/campanhas/:id/nicho-dados", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const campanhaId = Number(c.req.param("id"));
    const body = await c.req.json();

    const campRes = await client.query(
      `SELECT c.id, c.nicho_id, n.slug
       FROM campanhas c
       LEFT JOIN nichos n ON n.id = c.nicho_id
       WHERE c.id = $1 AND c.usuario_id = $2`,
      [campanhaId, user.id]
    );

    if (campRes.rows.length === 0) {
      return c.json({ error: "Campanha não encontrada" }, 404);
    }

    const { slug } = campRes.rows[0];

    if (slug === "imoveis") {
      await client.query(
        `INSERT INTO campanhas_imoveis
           (campanha_id, tipo_imovel, finalidade, valor_min, valor_max, regiao)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (campanha_id) DO UPDATE SET
           tipo_imovel = EXCLUDED.tipo_imovel,
           finalidade  = EXCLUDED.finalidade,
           valor_min   = EXCLUDED.valor_min,
           valor_max   = EXCLUDED.valor_max,
           regiao      = EXCLUDED.regiao`,
        [campanhaId,
         body.tipo_imovel ?? null, body.finalidade ?? null,
         body.valor_min ?? null, body.valor_max ?? null, body.regiao ?? null]
      );
    } else if (slug === "saude") {
      await client.query(
        `INSERT INTO campanhas_saude
           (campanha_id, operadora, tipo_plano, faixa_etaria_min,
            faixa_etaria_max, cobertura, acomodacao)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (campanha_id) DO UPDATE SET
           operadora        = EXCLUDED.operadora,
           tipo_plano       = EXCLUDED.tipo_plano,
           faixa_etaria_min = EXCLUDED.faixa_etaria_min,
           faixa_etaria_max = EXCLUDED.faixa_etaria_max,
           cobertura        = EXCLUDED.cobertura,
           acomodacao       = EXCLUDED.acomodacao`,
        [campanhaId,
         body.operadora ?? null, body.tipo_plano ?? null,
         body.faixa_etaria_min ?? null, body.faixa_etaria_max ?? null,
         body.cobertura ?? null, body.acomodacao ?? null]
      );
    } else if (slug === "suplementos") {
      await client.query(
        `INSERT INTO campanhas_suplementos
           (campanha_id, produto, objetivo, marca, publico_alvo)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (campanha_id) DO UPDATE SET
           produto      = EXCLUDED.produto,
           objetivo     = EXCLUDED.objetivo,
           marca        = EXCLUDED.marca,
           publico_alvo = EXCLUDED.publico_alvo`,
        [campanhaId,
         body.produto ?? null, body.objetivo ?? null,
         body.marca ?? null, body.publico_alvo ?? null]
      );
    } else {
      return c.json({ error: "Campanha sem nicho definido" }, 400);
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error("ERRO PUT /campanhas/:id/nicho-dados:", err);
    return c.json({ error: "Erro ao atualizar dados do nicho" }, 500);
  }
});

// vincular/trocar nicho de uma campanha existente (inclusive Meta)
app.patch("/campanhas/:id/nicho", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const campanhaId = Number(c.req.param("id"));
    const { nicho_id } = await c.req.json();

    if (!nicho_id) {
      return c.json({ error: "nicho_id obrigatório" }, 400);
    }

    const campRes = await client.query(
      `SELECT id FROM campanhas WHERE id = $1 AND usuario_id = $2`,
      [campanhaId, user.id]
    );
    if (campRes.rows.length === 0) {
      return c.json({ error: "Campanha não encontrada" }, 404);
    }

    const nichoRes = await client.query(
      `SELECT id FROM nichos WHERE id = $1`,
      [nicho_id]
    );
    if (nichoRes.rows.length === 0) {
      return c.json({ error: "Nicho inválido" }, 400);
    }

    await client.query(
      `UPDATE campanhas SET nicho_id = $1 WHERE id = $2`,
      [nicho_id, campanhaId]
    );

    return c.json({ ok: true });
  } catch (err) {
    console.error("ERRO PATCH /campanhas/:id/nicho:", err);
    return c.json({ error: "Erro ao vincular nicho" }, 500);
  }
});

/* =========================
   ⏰ CRON — LEMBRETES DE CONTATO
========================= */

async function notificarNovoLeadWhatsApp(
  usuarioId: number,
  dados: { nome?: string | null; telefone?: string | null; email?: string | null; campanha?: string | null }
) {
  try {
    const row = await client.query(
      `SELECT whatsapp, notif_whatsapp_lead FROM usuarios WHERE id = $1`,
      [usuarioId]
    );
    const u = row.rows[0];
    if (!u?.whatsapp || u?.notif_whatsapp_lead === false) return;
    console.log(`[notif-lead] enviando para usuário ${usuarioId} (${u.whatsapp})`);
    const agora = new Date().toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit"
    });
    const msg =
      `🎯 *Novo lead chegou!*\n\n` +
      `👤 *Nome:* ${dados.nome || "Não informado"}\n` +
      `📞 *Telefone:* ${dados.telefone || "Não informado"}\n` +
      `📧 *E-mail:* ${dados.email || "Não informado"}\n` +
      (dados.campanha ? `📣 *Campanha:* ${dados.campanha}\n` : "") +
      `⏰ *Horário:* ${agora}\n\n` +
      `Acesse a plataforma para ver todos os detalhes.`;
    await enviarLembreteWhatsApp(u.whatsapp, msg);
  } catch (e) {
    console.error("Erro notif lead WhatsApp:", e);
  }
}

async function enviarLembreteWhatsApp(telefone: string, mensagem: string) {
  const instanceId = Bun.env.ZAPI_INSTANCE_ID;
  const token      = Bun.env.ZAPI_TOKEN;

  if (!instanceId || !token) {
    console.warn("⚠️ Z-API: ZAPI_INSTANCE_ID ou ZAPI_TOKEN não configurados");
    return;
  }

  const numero = String(telefone).replace(/\D/g, "");
  if (!numero) {
    console.warn("⚠️ Z-API: número vazio, envio cancelado");
    return;
  }

  const phone = numero.startsWith("55") ? numero : `55${numero}`;
  const clientToken = Bun.env.ZAPI_CLIENT_TOKEN || "";

  try {
    const res = await fetch(`https://api.z-api.io/instances/${instanceId}/token/${token}/send-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(clientToken ? { "Client-Token": clientToken } : {})
      },
      body: JSON.stringify({ phone, message: mensagem })
    });
    const body = await res.json();
    if (res.ok) {
      console.log(`[z-api] ✅ enviado para ${phone}`);
    } else {
      console.error(`[z-api] ❌ erro ${res.status}:`, JSON.stringify(body));
    }
  } catch (e) {
    console.error("[z-api] ❌ exceção:", e);
  }
}

async function processarLembretesContato() {
  try {
    const hoje     = new Date().toISOString().slice(0, 10);
    const amanha   = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    // ── 1. Leads para contatar AMANHÃ (lembrete antecipado) ──
    const antecipados = await client.query(
      `SELECT l.id, l.nome, l.data_contato, l.usuario_id,
              u.nome AS corretor_nome, u.whatsapp AS corretor_whatsapp
       FROM leads l
       INNER JOIN usuarios u ON u.id = l.usuario_id
       WHERE l.data_contato = $1
         AND l.lembrete_1dia_enviado = FALSE`,
      [amanha]
    );

    for (const lead of antecipados.rows) {
      const dataFormatada = new Date(lead.data_contato + "T12:00:00").toLocaleDateString("pt-BR");
      const titulo = `Lembrete: contatar ${lead.nome} amanhã`;
      const mensagem = `Olá ${lead.corretor_nome}! Lembrete: amanhã (${dataFormatada}) é o dia combinado para entrar em contato com o lead *${lead.nome}*. Não esqueça! 📅`;

      // Notificação na plataforma
      await client.query(
        `INSERT INTO notificacoes (usuario_id, lead_id, tipo, titulo, mensagem)
         VALUES ($1, $2, 'lembrete_antecipado', $3, $4)`,
        [lead.usuario_id, lead.id, titulo, mensagem]
      );

      // WhatsApp
      if (lead.corretor_whatsapp) {
        await enviarLembreteWhatsApp(lead.corretor_whatsapp, mensagem);
      }

      await client.query(
        `UPDATE leads SET lembrete_1dia_enviado = TRUE WHERE id = $1`,
        [lead.id]
      );
    }

    // ── 2. Leads para contatar HOJE ──
    const hoje_leads = await client.query(
      `SELECT l.id, l.nome, l.data_contato, l.usuario_id,
              u.nome AS corretor_nome, u.whatsapp AS corretor_whatsapp
       FROM leads l
       INNER JOIN usuarios u ON u.id = l.usuario_id
       WHERE l.data_contato = $1
         AND l.lembrete_dia_enviado = FALSE`,
      [hoje]
    );

    for (const lead of hoje_leads.rows) {
      const dataFormatada = new Date(lead.data_contato + "T12:00:00").toLocaleDateString("pt-BR");
      const titulo = `Hoje é o dia: ligue para ${lead.nome}`;
      const mensagem = `Bom dia, ${lead.corretor_nome}! 🔔 Hoje (${dataFormatada}) é o dia combinado para entrar em contato com o lead *${lead.nome}*. Boa venda! 💪`;

      // Notificação na plataforma
      await client.query(
        `INSERT INTO notificacoes (usuario_id, lead_id, tipo, titulo, mensagem)
         VALUES ($1, $2, 'lembrete_dia', $3, $4)`,
        [lead.usuario_id, lead.id, titulo, mensagem]
      );

      // WhatsApp
      if (lead.corretor_whatsapp) {
        await enviarLembreteWhatsApp(lead.corretor_whatsapp, mensagem);
      }

      await client.query(
        `UPDATE leads SET lembrete_dia_enviado = TRUE WHERE id = $1`,
        [lead.id]
      );
    }

    if (antecipados.rows.length + hoje_leads.rows.length > 0) {
      console.log(`LEMBRETES: ${antecipados.rows.length} antecipados, ${hoje_leads.rows.length} no dia`);
    }
  } catch (e) {
    console.error("ERRO CRON LEMBRETES:", e);
  }
}

/* =========================
   👷 CRIADOR DE CAMPANHA
========================= */

// Lista corretores disponíveis para o criador de campanha atribuir rascunhos
app.get("/usuarios/corretores-disponiveis", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");

    if (
      user.tipo !== "criador_campanha" &&
      user.tipo !== "super_admin" &&
      user.tipo !== "master"
    ) {
      return c.json({ error: "Acesso negado" }, 403);
    }

    const resultado = await client.query(
      `SELECT id, nome, sobrenome, email, tipo, plano, ativo
       FROM usuarios
       WHERE tipo IN ('corretor', 'admin_corretor', 'corretor_receptor')
         AND COALESCE(ativo, true) = true
       ORDER BY nome ASC`
    );

    return c.json(resultado.rows);
  } catch (err) {
    console.error("ERRO GET /usuarios/corretores-disponiveis:", err);
    return c.json({ error: "Erro ao listar corretores" }, 500);
  }
});

// Criar rascunho de campanha
app.post("/campanhas/rascunho", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");

    if (
      user.tipo !== "criador_campanha" &&
      user.tipo !== "super_admin" &&
      user.tipo !== "master"
    ) {
      return c.json({ error: "Apenas criadores de campanha podem criar rascunhos" }, 403);
    }

    const { corretor_id, nome, configuracoes } = await c.req.json();

    if (!corretor_id || !nome) {
      return c.json({ error: "corretor_id e nome são obrigatórios" }, 400);
    }

    const corretorRes = await client.query(
      `SELECT id FROM usuarios WHERE id = $1 AND tipo IN ('corretor', 'admin_corretor') AND COALESCE(ativo, true) = true`,
      [corretor_id]
    );

    if (corretorRes.rows.length === 0) {
      return c.json({ error: "Corretor não encontrado ou inativo" }, 404);
    }

    const resultado = await client.query(
      `INSERT INTO campanhas_rascunho (criador_id, corretor_id, nome, configuracoes)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [user.id, corretor_id, nome, JSON.stringify(configuracoes || {})]
    );

    const rascunho = resultado.rows[0];

    // Notifica o corretor
    await client.query(
      `INSERT INTO notificacoes (usuario_id, tipo, titulo, mensagem)
       VALUES ($1, 'rascunho_campanha', 'Nova campanha aguardando ativação',
               $2)`,
      [
        corretor_id,
        `O criador preparou a campanha "${nome}" para você. Acesse e ative quando estiver pronto.`
      ]
    );

    return c.json(rascunho, 201);
  } catch (err) {
    console.error("ERRO POST /campanhas/rascunho:", err);
    return c.json({ error: "Erro ao criar rascunho" }, 500);
  }
});

// Listar rascunhos (criador vê os próprios; corretor vê os atribuídos a ele)
app.get("/campanhas/rascunho", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");

    let rows: any[];

    if (
      user.tipo === "criador_campanha" ||
      user.tipo === "super_admin" ||
      user.tipo === "master"
    ) {
      const filtroStatus = c.req.query("status");

      const resultado = await client.query(
        `SELECT r.*,
                c.nome AS corretor_nome, c.sobrenome AS corretor_sobrenome, c.email AS corretor_email,
                u.nome AS criador_nome
         FROM campanhas_rascunho r
         JOIN usuarios c ON c.id = r.corretor_id
         JOIN usuarios u ON u.id = r.criador_id
         WHERE r.criador_id = $1
           AND ($2::text IS NULL OR r.status = $2)
         ORDER BY r.criado_em DESC`,
        [user.tipo === "criador_campanha" ? user.id : null, filtroStatus || null]
      );

      // super_admin/master veem todos
      if (user.tipo !== "criador_campanha") {
        const todos = await client.query(
          `SELECT r.*,
                  c.nome AS corretor_nome, c.sobrenome AS corretor_sobrenome, c.email AS corretor_email,
                  u.nome AS criador_nome
           FROM campanhas_rascunho r
           JOIN usuarios c ON c.id = r.corretor_id
           JOIN usuarios u ON u.id = r.criador_id
           WHERE ($1::text IS NULL OR r.status = $1)
           ORDER BY r.criado_em DESC`,
          [filtroStatus || null]
        );
        rows = todos.rows;
      } else {
        rows = resultado.rows;
      }
    } else if (
      user.tipo === "corretor" ||
      user.tipo === "admin_corretor"
    ) {
      const filtroStatus = c.req.query("status");

      const resultado = await client.query(
        `SELECT r.*,
                u.nome AS criador_nome,
                u.email AS criador_email
         FROM campanhas_rascunho r
         JOIN usuarios u ON u.id = r.criador_id
         WHERE r.corretor_id = $1
           AND ($2::text IS NULL OR r.status = $2)
         ORDER BY r.criado_em DESC`,
        [user.id, filtroStatus || null]
      );

      rows = resultado.rows;
    } else {
      return c.json({ error: "Acesso negado" }, 403);
    }

    return c.json(rows);
  } catch (err) {
    console.error("ERRO GET /campanhas/rascunho:", err);
    return c.json({ error: "Erro ao listar rascunhos" }, 500);
  }
});

// Buscar rascunho por ID
app.get("/campanhas/rascunho/:id", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const id = Number(c.req.param("id"));

    const resultado = await client.query(
      `SELECT r.*,
              c.nome AS corretor_nome, c.sobrenome AS corretor_sobrenome, c.email AS corretor_email,
              u.nome AS criador_nome, u.email AS criador_email
       FROM campanhas_rascunho r
       JOIN usuarios c ON c.id = r.corretor_id
       JOIN usuarios u ON u.id = r.criador_id
       WHERE r.id = $1`,
      [id]
    );

    if (resultado.rows.length === 0) {
      return c.json({ error: "Rascunho não encontrado" }, 404);
    }

    const rascunho = resultado.rows[0];

    const podeVer =
      user.tipo === "super_admin" ||
      user.tipo === "master" ||
      rascunho.criador_id === user.id ||
      rascunho.corretor_id === user.id;

    if (!podeVer) {
      return c.json({ error: "Acesso negado" }, 403);
    }

    return c.json(rascunho);
  } catch (err) {
    console.error("ERRO GET /campanhas/rascunho/:id:", err);
    return c.json({ error: "Erro ao buscar rascunho" }, 500);
  }
});

// Atualizar rascunho (somente criador, enquanto pendente)
app.patch("/campanhas/rascunho/:id", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const id = Number(c.req.param("id"));

    const rascunhoRes = await client.query(
      `SELECT * FROM campanhas_rascunho WHERE id = $1`,
      [id]
    );

    if (rascunhoRes.rows.length === 0) {
      return c.json({ error: "Rascunho não encontrado" }, 404);
    }

    const rascunho = rascunhoRes.rows[0];

    if (
      rascunho.criador_id !== user.id &&
      user.tipo !== "super_admin" &&
      user.tipo !== "master"
    ) {
      return c.json({ error: "Acesso negado" }, 403);
    }

    if (rascunho.status !== "pendente") {
      return c.json({ error: "Apenas rascunhos pendentes podem ser editados" }, 400);
    }

    const { nome, corretor_id, configuracoes } = await c.req.json();

    const campos: string[] = [];
    const valores: any[] = [];
    let idx = 1;

    if (nome) { campos.push(`nome = $${idx++}`); valores.push(nome); }
    if (corretor_id) { campos.push(`corretor_id = $${idx++}`); valores.push(corretor_id); }
    if (configuracoes !== undefined) { campos.push(`configuracoes = $${idx++}`); valores.push(JSON.stringify(configuracoes)); }
    campos.push(`atualizado_em = NOW()`);

    if (campos.length === 1) {
      return c.json({ error: "Nenhum campo para atualizar" }, 400);
    }

    valores.push(id);

    const atualizado = await client.query(
      `UPDATE campanhas_rascunho SET ${campos.join(", ")} WHERE id = $${idx} RETURNING *`,
      valores
    );

    return c.json(atualizado.rows[0]);
  } catch (err) {
    console.error("ERRO PATCH /campanhas/rascunho/:id:", err);
    return c.json({ error: "Erro ao atualizar rascunho" }, 500);
  }
});

// Cancelar/excluir rascunho (somente criador, enquanto pendente)
app.delete("/campanhas/rascunho/:id", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const id = Number(c.req.param("id"));

    const rascunhoRes = await client.query(
      `SELECT * FROM campanhas_rascunho WHERE id = $1`,
      [id]
    );

    if (rascunhoRes.rows.length === 0) {
      return c.json({ error: "Rascunho não encontrado" }, 404);
    }

    const rascunho = rascunhoRes.rows[0];

    if (
      rascunho.criador_id !== user.id &&
      user.tipo !== "super_admin" &&
      user.tipo !== "master"
    ) {
      return c.json({ error: "Acesso negado" }, 403);
    }

    if (rascunho.status === "ativado") {
      return c.json({ error: "Rascunho já ativado não pode ser excluído" }, 400);
    }

    await client.query(
      `UPDATE campanhas_rascunho SET status = 'cancelado', atualizado_em = NOW() WHERE id = $1`,
      [id]
    );

    return c.json({ ok: true });
  } catch (err) {
    console.error("ERRO DELETE /campanhas/rascunho/:id:", err);
    return c.json({ error: "Erro ao cancelar rascunho" }, 500);
  }
});

// Corretor rejeita rascunho
app.post("/campanhas/rascunho/:id/rejeitar", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const id = Number(c.req.param("id"));

    const rascunhoRes = await client.query(
      `SELECT * FROM campanhas_rascunho WHERE id = $1`,
      [id]
    );

    if (rascunhoRes.rows.length === 0) {
      return c.json({ error: "Rascunho não encontrado" }, 404);
    }

    const rascunho = rascunhoRes.rows[0];

    if (rascunho.corretor_id !== user.id) {
      return c.json({ error: "Apenas o corretor destinatário pode rejeitar este rascunho" }, 403);
    }

    if (rascunho.status !== "pendente") {
      return c.json({ error: "Rascunho não está pendente" }, 400);
    }

    const { motivo } = await c.req.json();

    const atualizado = await client.query(
      `UPDATE campanhas_rascunho
       SET status = 'rejeitado', motivo_rejeicao = $1, atualizado_em = NOW()
       WHERE id = $2
       RETURNING *`,
      [motivo || null, id]
    );

    // Notifica o criador
    await client.query(
      `INSERT INTO notificacoes (usuario_id, tipo, titulo, mensagem)
       VALUES ($1, 'rascunho_rejeitado', 'Campanha rejeitada pelo corretor', $2)`,
      [
        rascunho.criador_id,
        `O corretor rejeitou a campanha "${rascunho.nome}".${motivo ? ` Motivo: ${motivo}` : ""}`
      ]
    );

    return c.json(atualizado.rows[0]);
  } catch (err) {
    console.error("ERRO POST /campanhas/rascunho/:id/rejeitar:", err);
    return c.json({ error: "Erro ao rejeitar rascunho" }, 500);
  }
});

// Corretor ativa rascunho — cria a campanha real no Meta usando as credenciais do corretor
app.post("/campanhas/rascunho/:id/ativar", authMiddleware, async (c) => {
  try {
    const user: any = c.get("user");
    const id = Number(c.req.param("id"));

    if (
      user.tipo !== "corretor" &&
      user.tipo !== "admin_corretor" &&
      user.tipo !== "super_admin" &&
      user.tipo !== "master"
    ) {
      return c.json({ error: "Apenas o corretor pode ativar rascunhos" }, 403);
    }

    const rascunhoRes = await client.query(
      `SELECT * FROM campanhas_rascunho WHERE id = $1`,
      [id]
    );

    if (rascunhoRes.rows.length === 0) {
      return c.json({ error: "Rascunho não encontrado" }, 404);
    }

    const rascunho = rascunhoRes.rows[0];

    if (
      rascunho.corretor_id !== user.id &&
      user.tipo !== "super_admin" &&
      user.tipo !== "master"
    ) {
      return c.json({ error: "Este rascunho não está atribuído a você" }, 403);
    }

    if (rascunho.status !== "pendente") {
      return c.json({ error: "Rascunho não está pendente" }, 400);
    }

    // Busca credenciais Meta do corretor
    const metaRes = await client.query(
      `SELECT access_token, conta_anuncios_id FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1`,
      [rascunho.corretor_id]
    );

    if (metaRes.rows.length === 0) {
      return c.json({ error: "Corretor não possui conta Meta conectada" }, 400);
    }

    const token = metaRes.rows[0].access_token;
    const contaAds = await obterContaAnuncios(token, metaRes.rows[0].conta_anuncios_id);

    if (!contaAds) {
      return c.json({ error: "Nenhuma conta de anúncios encontrada para este corretor" }, 400);
    }

    const adAccountId = contaAds.id;
    const cfg = rascunho.configuracoes || {};
    const cfgCampanha = cfg.campanha || {};
    const cfgPublico = cfg.publico || {};
    const cfgFormulario = cfg.formulario || {};
    const cfgCriativo = cfg.criativo || {};

    // 1. Cria campanha no Meta
    const categoriaEspecial = textoOpcional(cfgCampanha.categoria_especial);
    const payloadCampanha: any = {
      name: rascunho.nome,
      objective: cfgCampanha.objetivo || "OUTCOME_LEADS",
      status: "PAUSED",
      special_ad_categories: categoriaEspecial ? [categoriaEspecial] : [],
      is_adset_budget_sharing_enabled: false,
      access_token: token
    };

    if (cfgCampanha.orcamento_diario_centavos) {
      payloadCampanha.daily_budget = cfgCampanha.orcamento_diario_centavos;
    }

    const campanhaMeta = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/campaigns`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payloadCampanha) }
    ).then(r => r.json());

    if (!campanhaMeta.id) {
      return c.json({ error: "Erro ao criar campanha no Meta", detalhe: campanhaMeta }, 400);
    }

    // 2. Busca page_id disponível do corretor
    let pageId = textoOpcional(cfgCriativo.page_id);

    if (!pageId) {
      const pagesRes = await fetch(
        `https://graph.facebook.com/v19.0/me/accounts?access_token=${token}`
      ).then(r => r.json());

      if (pagesRes.data && pagesRes.data.length > 0) {
        pageId = pagesRes.data[0].id;
      }
    }

    if (!pageId) {
      return c.json({
        error: "Nenhuma página do Facebook encontrada para o corretor. Configure uma página antes de ativar.",
        campaign_id: campanhaMeta.id
      }, 400);
    }

    // 3. Cria adset
    const targeting = montarTargetingMeta({
      ...cfgPublico,
      categoria_especial: cfgCampanha.categoria_especial
    });

    const publicosPersonalizados = Array.isArray(cfgPublico.publicos_personalizados)
      ? cfgPublico.publicos_personalizados.map((pid: any) => ({ id: String(pid) })).filter((p: any) => p.id)
      : [];

    if (publicosPersonalizados.length) {
      targeting.custom_audiences = publicosPersonalizados;
    }

    const controleCustoRascunho =
      prepararControleCustoMeta(
        cfgCampanha.bid_strategy,
        cfgCampanha.bid_amount
      );

    const payloadAdset: any = {
      name: `AdSet ${rascunho.nome} ${Date.now()}`,
      campaign_id: campanhaMeta.id,
      billing_event: "IMPRESSIONS",
      optimization_goal: "LEAD_GENERATION",
      destination_type: "ON_AD",
      daily_budget: cfgPublico.orcamento_diario_centavos || cfgCampanha.orcamento_diario_centavos || 2000,
      start_time: new Date(Date.now() + 60000).toISOString(),
      targeting,
      promoted_object: { page_id: pageId },
      status: "PAUSED",
      access_token: token
    };

    if (controleCustoRascunho.bidStrategy) {
      payloadAdset.bid_strategy =
        controleCustoRascunho.bidStrategy;
    }

    if (
      controleCustoRascunho.bidAmount !== null &&
      bidStrategyExigeValor(payloadAdset.bid_strategy)
    ) {
      payloadAdset.bid_amount =
        Math.round(controleCustoRascunho.bidAmount * 100);
    }

    const adsetMeta = await enviarPayloadMetaComFallbackBid(
      `https://graph.facebook.com/v19.0/${adAccountId}/adsets`,
      payloadAdset,
      "ATIVAR_RASCUNHO_ADSET"
    );

    if (adsetMeta.error) {
      return c.json({ error: "Erro ao criar adset no Meta", detalhe: adsetMeta, campaign_id: campanhaMeta.id }, 400);
    }

    // 4. Cria formulário de lead
    const pagesDetalhes = await fetch(
      `https://graph.facebook.com/v19.0/me/accounts?access_token=${token}`
    ).then(r => r.json());

    const pagina = pagesDetalhes.data?.find((p: any) => p.id === pageId);
    let formId: string | null = null;

    if (pagina?.access_token) {
      const perguntasExtras = Array.isArray(cfgFormulario.perguntas_customizadas)
        ? cfgFormulario.perguntas_customizadas.slice(0, 4).map((q: string, i: number) => ({
            type: "CUSTOM", key: `qualificacao_${i + 1}`, label: q
          }))
        : [];

      const payloadForm: any = {
        name: `Form ${rascunho.nome} ${Date.now()}`,
        locale: "pt_BR",
        questions: [
          { type: "FULL_NAME" },
          { type: "EMAIL" },
          { type: "PHONE" },
          ...perguntasExtras
        ],
        privacy_policy: {
          url: urlOpcional(cfgFormulario.url_privacidade, "https://google.com"),
          link_text: "Política de Privacidade"
        },
        thank_you_page: {
          title: textoOpcional(cfgFormulario.mensagem_agradecimento_titulo) || "Obrigado!",
          body: textoOpcional(cfgFormulario.mensagem_agradecimento) || "Recebemos seus dados 🚀",
          button_type: "VIEW_WEBSITE",
          button_text: "Ver mais",
          website_url: urlOpcional(cfgFormulario.url_privacidade, "https://google.com")
        },
        access_token: pagina.access_token
      };

      const formMeta = await fetch(
        `https://graph.facebook.com/v19.0/${pageId}/leadgen_forms`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payloadForm) }
      ).then(r => r.json());

      if (formMeta.id) {
        formId = formMeta.id;
      }
    }

    // 5. Salva na tabela campanhas
    const campanhaBanco = await client.query(
      `INSERT INTO campanhas (usuario_id, campaign_id, adset_id, form_id, page_id, conta_anuncios_id, nome, status, origem, configuracoes_avancadas, nicho_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PAUSED', 'rascunho', $8, $9)
       RETURNING id`,
      [
        rascunho.corretor_id,
        campanhaMeta.id,
        adsetMeta.id || null,
        formId,
        pageId,
        adAccountId,
        rascunho.nome,
        JSON.stringify({ origem_rascunho_id: rascunho.id }),
        cfg.nicho_id || null
      ]
    );

    const campanhaId = campanhaBanco.rows[0].id;

    // 6. Atualiza rascunho como ativado
    await client.query(
      `UPDATE campanhas_rascunho SET status = 'ativado', ativado_em = NOW(), campanha_id = $1, atualizado_em = NOW() WHERE id = $2`,
      [campanhaId, id]
    );

    // Notifica o criador
    await client.query(
      `INSERT INTO notificacoes (usuario_id, tipo, titulo, mensagem)
       VALUES ($1, 'rascunho_ativado', 'Campanha ativada pelo corretor', $2)`,
      [
        rascunho.criador_id,
        `O corretor ativou a campanha "${rascunho.nome}" com sucesso.`
      ]
    );

    return c.json({
      ok: true,
      campaign_id: campanhaMeta.id,
      adset_id: adsetMeta.id || null,
      form_id: formId,
      campanha_id: campanhaId
    });

  } catch (err) {
    console.error("ERRO POST /campanhas/rascunho/:id/ativar:", err);
    return c.json({ error: "Erro ao ativar rascunho" }, 500);
  }
});

// Agendador: verifica a cada hora se são 8h (BRT = UTC-3)
function agendarLembretes() {
  const HORA_ENVIO = 8; // 8h horário de Brasília
  const verificar = () => {
    const agora = new Date();
    const horaBRT = (agora.getUTCHours() - 3 + 24) % 24;
    if (horaBRT === HORA_ENVIO) {
      processarLembretesContato();
    }
  };
  // Verifica a cada 30 minutos
  setInterval(verificar, 30 * 60 * 1000);
  // Roda uma vez ao iniciar (útil se servidor reiniciou às 8h)
  verificar();
}

agendarLembretes();


/* =========================
   🔔 ALERTAS RAILWAY
========================= */

async function verificarAlertasRailway() {
  try {
    const cfg = await client.query(`SELECT * FROM railway_billing_config WHERE id = 1 LIMIT 1`);
    if (!cfg.rows.length) return;
    const b = cfg.rows[0];

    const admins = await client.query(`SELECT id FROM usuarios WHERE tipo = 'super_admin'`);
    if (!admins.rows.length) return;

    const hoje = new Date().toISOString().slice(0, 10);

    // Alerta de dia de cobrança
    const dataFatura = b.proxima_fatura_data ? String(b.proxima_fatura_data).slice(0, 10) : null;
    const ultimaNotifCobranca = b.ultima_notif_cobranca_data ? String(b.ultima_notif_cobranca_data).slice(0, 10) : null;

    if (dataFatura === hoje && ultimaNotifCobranca !== hoje) {
      const base = Number(b.proxima_fatura_base || 0);
      const moeda = b.moeda || "USD";
      const valorFmt = new Intl.NumberFormat(moeda === "BRL" ? "pt-BR" : "en-US", {
        style: "currency", currency: moeda
      }).format(base);

      for (const admin of admins.rows) {
        await client.query(
          `INSERT INTO notificacoes (usuario_id, tipo, titulo, mensagem)
           VALUES ($1, 'railway_cobranca_dia', $2, $3)`,
          [
            admin.id,
            "Railway: fatura vence hoje",
            `Hoje é o dia de cobrança da Railway. Valor base esperado: ${valorFmt}. Confira sua fatura no painel Railway.`
          ]
        );
      }
      await client.query(`UPDATE railway_billing_config SET ultima_notif_cobranca_data = $1 WHERE id = 1`, [hoje]);
    }

    // Alerta de custo estimado alto
    const limiteUsd = Number(b.limite_alerta_usd || 5);
    const mem = process.memoryUsage();
    const rssMb = mem.rss / 1024 / 1024;
    const custoRamEstimado = (rssMb / 1024) * 10;
    const ultimaNotifCusto = b.ultima_notif_custo_data ? String(b.ultima_notif_custo_data).slice(0, 10) : null;

    if (custoRamEstimado > limiteUsd && ultimaNotifCusto !== hoje) {
      for (const admin of admins.rows) {
        await client.query(
          `INSERT INTO notificacoes (usuario_id, tipo, titulo, mensagem)
           VALUES ($1, 'railway_custo_alto', $2, $3)`,
          [
            admin.id,
            "Railway: custo estimado acima do limite",
            `O custo estimado de RAM está em US$ ${custoRamEstimado.toFixed(2)}/mês (RSS: ${rssMb.toFixed(0)} MB), acima do limite configurado de US$ ${limiteUsd.toFixed(2)}. Acesse Recursos Railway para detalhes.`
          ]
        );
      }
      await client.query(`UPDATE railway_billing_config SET ultima_notif_custo_data = $1 WHERE id = 1`, [hoje]);
    }
  } catch (err) {
    console.error("ERRO verificarAlertasRailway:", err);
  }
}

// Verifica a cada hora
setInterval(verificarAlertasRailway, 60 * 60 * 1000);
verificarAlertasRailway();


/* =========================
   🚀 START
========================= */

Bun.serve({
  port: Number(Bun.env.PORT) || 3000,
  fetch: app.fetch,
});
