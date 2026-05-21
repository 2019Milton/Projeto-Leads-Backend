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

const TOKEN_TTL_SECONDS =
  Number(Bun.env.TOKEN_TTL_SECONDS) ||
  60 * 60 * 24 * 7;

const RESET_PASSWORD_TTL_MINUTES =
  Number(Bun.env.RESET_PASSWORD_TTL_MINUTES) ||
  30;

const RESEND_FROM_EMAIL =
  Bun.env.RESEND_FROM_EMAIL ||
  Bun.env.RESEND_FROM ||
  "Plataforma de Leads <onboarding@resend.dev>";

const SENHA_FORTE =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#._-]).{8,}$/;

if (TOKEN_SECRET === DEFAULT_TOKEN_SECRET) {
  console.warn(
    "JWT_SECRET nao configurado. Defina essa variavel no Railway em producao."
  );
}

const allowedOrigins = new Set(
  [
    Bun.env.FRONTEND_URL,
    Bun.env.VERCEL_URL ? `https://${Bun.env.VERCEL_URL}` : null,
    "https://projeto-leads-snowy.vercel.app"
  ].filter(Boolean) as string[]
);

function resolverOrigemCors(origin: string) {
  if (!origin) {
    return "*";
  }

  if (
    allowedOrigins.has(origin) ||
    origin.endsWith(".vercel.app")
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

  if (partes.length >= 7) {
    const payload = partes.slice(0, 6).join(":");
    const expiraEm = Number(partes[5]);
    const assinatura = partes[6];
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
  } else if (Bun.env.REJECT_LEGACY_TOKENS === "true") {
    return null;
  }

  return {
    id: Number(id),
    email,
    tipo,
    nome: partes[3] || "",
    sobrenome: partes[4] || ""
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
    "https://projeto-leads-snowy.vercel.app"
  ).replace(/\/+$/g, "");
}

function textoOpcional(value: unknown) {
  return String(value ?? "").trim();
}

function numeroOpcional(value: unknown) {
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
      countries: [pais]
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

  // 🆕 Lead novo
  pontos += 10;
  base.push("+10 Lead recém capturado");

  // 📢 Origem Meta
  if (lead.origem === "meta") {

    pontos += 15;
    base.push("+15 Veio de campanha Meta");
  }

  // 📈 CTR da campanha
  const ctr =
    Number(lead.ctr || 0);

  if (ctr >= 4) {

    pontos += 10;
    base.push("+10 Campanha com CTR acima de 4%");
  }

  // 🎯 Campanha de intenção forte
  const campanha =
    (lead.campanha || "").toLowerCase();

  if (
    campanha.includes("visita") ||
    campanha.includes("agendar") ||
    campanha.includes("financiamento") ||
    campanha.includes("simulação") ||
    campanha.includes("simulacao") ||
    campanha.includes("entrada")
  ) {

    pontos += 30;
    base.push("+30 Campanha indica intenção forte");
  }

  // 💬 Observações do corretor
  const obs =
    (lead.observacao || "").toLowerCase();

  if (
    obs.includes("visita") ||
    obs.includes("interesse") ||
    obs.includes("entrada") ||
    obs.includes("financiamento") ||
    obs.includes("proposta") ||
    obs.includes("fotos")
  ) {

    pontos += 30;
    base.push("+30 Observação indica interesse forte");
  }

  if (
    obs.includes("não responde") ||
    obs.includes("nao responde") ||
    obs.includes("sem interesse") ||
    obs.includes("desistiu")
  ) {

    pontos -= 30;
    base.push("-30 Observação indica baixo interesse");
  }

  // 🔄 Lead repetido
  if (lead.repetido) {

    pontos += 20;
    base.push("+20 Lead retornou novamente");
  }

  // ⏳ Tempo parado
  const criado =
    new Date(lead.criado_em);

  const agora =
    new Date();

  const dias =
    Math.floor(
      (agora.getTime() - criado.getTime()) /
      (1000 * 60 * 60 * 24)
    );

  if (dias >= 15) {

    pontos -= 40;
    base.push("-40 Lead parado há mais de 15 dias");

  } else if (dias >= 7) {

    pontos -= 20;
    base.push("-20 Lead parado há mais de 7 dias");
  }

  // ✅ Status atual
  if (lead.status === "primeiro_contato") {

    pontos += 10;
    base.push("+10 Primeiro contato realizado");
  }

  if (lead.status === "em_conversa") {

    pontos += 30;
    base.push("+30 Lead em conversa");
  }

  if (lead.status === "fechado") {

    pontos += 50;
    base.push("+50 Lead fechado");
  }

  if (lead.status === "perdido") {

    pontos -= 60;
    base.push("-60 Lead perdido");
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

    c.set("user", user);

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

async function obterContaAnuncios(token: string) {

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

    return null;
  }

  return adAccounts.data[0];
}



async function sincronizarTodasCampanhas() {

  try {

    console.log("🔄 AUTO SYNC INICIADO");

    // 🔥 BUSCA TODOS USUÁRIOS COM META
    const usuarios = await client.query(`
      SELECT DISTINCT usuario_id, access_token
      FROM meta_conexoes
    `);

    for (const user of usuarios.rows) {

      try {

        const token = user.access_token;

        // 🔥 CONTAS
        const contaAds =
          await obterContaAnuncios(token);
        
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
                atualizado_em = NOW()
              WHERE campaign_id = $3
              `,
              [
                campanha.name,
                statusFinal,
                campanha.id
              ]
            );

          } else {

            await client.query(
              `
              INSERT INTO campanhas (
                usuario_id,
                campaign_id,
                nome,
                status,
                origem,
                atualizado_em
              )
              VALUES ($1,$2,$3,$4,$5,NOW())
              `,
              [
                user.usuario_id,
                campanha.id,
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
app.get("/auth/meta/login", (c) => {

  const token = c.req.query("token");

  if (!token) {
    return c.text("Token não enviado");
  }

  const clientId = Bun.env.META_APP_ID;
  const redirectUri = Bun.env.META_REDIRECT_URI;

  // 🔥 repassa token no state
  const state = encodeURIComponent(token);

  const scopes = [

    "ads_management",
    "ads_read",
    "business_management",
    "leads_retrieval",
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_ads"

  ].join(",");

  const url =
    `https://www.facebook.com/v19.0/dialog/oauth` +
    `?client_id=${clientId}` +
    `&redirect_uri=${redirectUri}` +
    `&scope=${scopes}` +
    `&state=${state}`;

  return c.redirect(url);
});


// 🔹 CALLBACK (SALVA TOKEN)
app.get("/auth/meta/callback", async (c) => {
  try {
    const code = c.req.query("code");

    if (!code) {
      return c.text("Erro: code não recebido");
    }

    const clientId = Bun.env.META_APP_ID;
    const clientSecret = Bun.env.META_APP_SECRET;
    const redirectUri = Bun.env.META_REDIRECT_URI;

    // 🔥 troca code por token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${clientId}&redirect_uri=${redirectUri}&client_secret=${clientSecret}&code=${code}`
    );

    const tokenData = await tokenRes.json();
    const access_token = tokenData.access_token;

    console.log("TOKEN META:", tokenData);

    // 🔐 pega token do state
    const state = c.req.query("state");
    
    if (!state) {
      return c.text("State não recebido");
    }
    
    // 🔓 decodifica token login
    const decoded = atob(state);
    
    const [usuario_id] = decoded.split(":");
    
    if (!usuario_id) {
      return c.text("Usuário inválido");
    }

    // 💾 salva no banco
    await client.query(
      "INSERT INTO meta_conexoes (usuario_id, access_token) VALUES ($1, $2)",
      [usuario_id, access_token]
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

app.get("/meta/teste", async (c) => {
  try {
    const result = await client.query(
      "SELECT access_token FROM meta_conexoes ORDER BY id DESC LIMIT 1"
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


app.post("/meta/campanha", async (c) => {
  try {
    const {
      usuario_id,
      nome,
      objetivo,
      configuracoes_avancadas
    } = await c.req.json();

    const conn = await client.query(
      "SELECT access_token FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1",
      [usuario_id]
    );

    const token = conn.rows[0].access_token;

    const contaAds =
      await obterContaAnuncios(token);
    
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
        nome,
        status,
        origem,
        configuracoes_avancadas
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      `,
      [
        usuario_id,
        campanha.id,
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

app.post("/meta/adset", async (c) => {
  try {
    const {
      usuario_id,
      campaign_id,
      page_id,
      form_id,
      daily_budget,
      configuracoes_avancadas
    } = await c.req.json();

    const conn = await client.query(
      "SELECT access_token FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1",
      [usuario_id]
    );

    const token = conn.rows[0].access_token;

    const contaAds =
      await obterContaAnuncios(token);
    
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

    console.log("ADSET RESPONSE:", adset);

    return c.json(adset);

  } catch (err) {
    console.error(err);
    return c.json({ error: "Erro ao criar adset" }, 500);
  }
});


app.post("/meta/formulario", async (c) => {
  try {
    const {
      usuario_id,
      adset_id,
      page_id,
      form_id,
      texto,
      cta,
      configuracoes_avancadas
    } = await c.req.json();

    // 🔐 pega token salvo
    const conn = await client.query(
      "SELECT access_token FROM meta_conexoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1",
      [usuario_id]
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


app.post("/meta/upload-imagem", async (c) => {

  try {

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
      SELECT access_token
      FROM meta_conexoes
      WHERE usuario_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [usuario_id]
    );

    if (conn.rows.length === 0) {

      return c.json({
        error: "Meta não conectada"
      }, 400);
    }

    const token = conn.rows[0].access_token;

    // 🔥 CONTA DE ANÚNCIOS
    const contaAds =
      await obterContaAnuncios(token);

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



app.post("/meta/anuncio", async (c) => {

  try {

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
      imageHash
    } = await c.req.json();

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
      SELECT access_token
      FROM meta_conexoes
      WHERE usuario_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [usuario_id]
    );

    if (conn.rows.length === 0) {

      return c.json({
        error: "Meta não conectada"
      }, 400);
    }

    const token = conn.rows[0].access_token;

    // 🔥 CONTA ADS
    const contaAds =
      await obterContaAnuncios(token);

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

            link_data: {

              link: linkDestino,

              image_hash: imageHash,

              message:
                texto ||
                "Quer mais clientes? 🚀",

              name: tituloAnuncio,

              description: descricaoAnuncio,

              call_to_action: {

                type:
                  cta ||
                  "LEARN_MORE",

                value: {
                  lead_gen_form_id: form_id
                }
              }
            }
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
      SELECT access_token, ultimo_sync
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
    const contaAds =
      await obterContaAnuncios(token);
    
    if (!contaAds) {
    
      return c.json({
        error: "Nenhuma conta de anúncios encontrada"
      }, 400);
    }
    
    const adAccountId = contaAds.id;

    const conta = contaAds;

    // 🔥 PÁGINAS
    const pages = await fetch(
      `https://graph.facebook.com/v19.0/me/accounts?access_token=${token}`
    ).then(r => r.json());

    const primeiraPagina = pages.data?.[0];

    // 🔥 INSTAGRAM
    let instagram = null;

    if (primeiraPagina?.id) {

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
      `,
      [usuario_id]
    );

    const campanhasAtivas = await client.query(
      `
      SELECT COUNT(*) as total
      FROM campanhas
      WHERE usuario_id = $1
      AND status = 'ACTIVE'
      `,
      [usuario_id]
    );

    const leadsHoje = await client.query(
      `
      SELECT COUNT(*) as total
      FROM leads
      WHERE usuario_id = $1
      AND DATE(criado_em) = CURRENT_DATE
      `,
      [usuario_id]
    );

    let gastoHoje = 0;

    try {

      const insightsHoje = await fetch(
        `https://graph.facebook.com/v19.0/${adAccountId}/insights?fields=spend&date_preset=today&access_token=${token}`
      ).then(r => r.json());

      gastoHoje =
        Number(insightsHoje.data?.[0]?.spend || 0);

    } catch (err) {

      console.error(
        "ERRO GASTO HOJE:",
        err
      );
    }

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

    const tipoPagamento =
      pagamentoAutomatico
        ? "automatico"
        : pagamentoManual
        ? "manual_pre_pago"
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
        saldo: conta.balance ?? null,
        pre_pago: pagamentoManual,
        ativa: contaAtiva,
        tipo_pagamento: tipoPagamento,
        pagamento_automatico: pagamentoAutomatico,
        pagamento_manual: pagamentoManual,
        pagamento_habilitado: pagamentoHabilitado,
        possui_pagamento: pagamentoHabilitado
      },

      paginas: pages.data || [],

      instagram,

      metricas: {
        campanhas: campanhasCount.rows[0].total,
        campanhas_ativas: campanhasAtivas.rows[0].total,
        leads_hoje: leadsHoje.rows[0].total,
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

app.post("/meta/desconectar", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

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

    const body = await c.req.json();

    console.log(
      "LEAD RECEBIDO:",
      JSON.stringify(body, null, 2)
    );

    // 🔥 EVENTOS
    if (body.entry) {

      for (const entry of body.entry) {

        for (const change of entry.changes || []) {

          // 🔥 LEADGEN
          if (change.field === "leadgen") {

            const lead = change.value;

            console.log("NOVO LEAD:", lead);
            
            const leadgen_id = lead.leadgen_id;
            
            const page_id = lead.page_id;
            
            
            // 🔐 BUSCA TOKEN DA PÁGINA
            const conn = await client.query(
              `
              SELECT access_token
              FROM meta_conexoes
              ORDER BY id DESC
              LIMIT 1
              `
            );
            
            if (conn.rows.length === 0) {
            
              console.log("SEM TOKEN META");
            
              continue;
            }
            
            const token = conn.rows[0].access_token;
            
            
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
            
            for (const field of leadData.field_data || []) {
            
              if (
                field.name === "full_name"
              ) {
            
                nome = field.values?.[0];
              }
            
              if (
                field.name === "email"
              ) {
            
                email = field.values?.[0];
              }
            
              if (
                field.name === "phone_number"
              ) {
            
                telefone = field.values?.[0];
              }
            }
            
            
            // 💾 SALVA LEAD REAL
            await client.query(
              `
              INSERT INTO leads (
                nome,
                email,
                telefone,
                origem
              )
              VALUES ($1,$2,$3,$4)
              `,
              [
                nome || "Lead Facebook",
                email,
                telefone,
                "meta"
              ]
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
  ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS nome TEXT,
    ADD COLUMN IF NOT EXISTS sobrenome TEXT,
    ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT true,
    ADD COLUMN IF NOT EXISTS admin_id INTEGER,
    ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
`);

await client.query(`
  ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS lead_id TEXT,
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
    ADD COLUMN IF NOT EXISTS ultimo_sync TIMESTAMP;
`);

await client.query(`
  ALTER TABLE campanhas
    ADD COLUMN IF NOT EXISTS adset_id TEXT,
    ADD COLUMN IF NOT EXISTS ad_id TEXT,
    ADD COLUMN IF NOT EXISTS form_id TEXT,
    ADD COLUMN IF NOT EXISTS page_id TEXT,
    ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP,
    ADD COLUMN IF NOT EXISTS configuracoes_avancadas JSONB;
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
  CREATE INDEX IF NOT EXISTS idx_meta_conexoes_usuario_id
    ON meta_conexoes(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash
    ON password_reset_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_usuario
    ON password_reset_tokens(usuario_id);
`);

/* =========================
   🔐 LOGIN
========================= */

app.post("/auth/solicitar-reset-senha", async (c) => {
  try {
    const { email } = await c.req.json();

    if (!email) {
      return c.json({
        error: "Email obrigatorio"
      }, 400);
    }

    const usuario = await client.query(
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
      await client.query("BEGIN");

      const token = gerarTokenResetSenha();
      const tokenHash = hashTokenResetSenha(token);
      const resetUrl =
        `${obterFrontendUrl()}/?reset_token=${encodeURIComponent(token)}`;

      await client.query(
        `
        UPDATE password_reset_tokens
        SET usado_em = NOW()
        WHERE usuario_id = $1
        AND usado_em IS NULL
        `,
        [user.id]
      );

      await client.query(
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

      await enviarEmailResetSenha(
        user.email,
        user.nome,
        resetUrl
      );

      await client.query("COMMIT");
    }

    return c.json({
      success: true,
      message: "Se o email estiver cadastrado, enviaremos um link para troca de senha."
    });

  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});

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
  }
});

app.get("/auth/validar-reset-senha", async (c) => {
  try {
    const token = c.req.query("token");

    if (!token) {
      return c.json({
        valido: false,
        error: "Token obrigatorio"
      }, 400);
    }

    const resetToken =
      await buscarResetTokenValido(token);

    if (!resetToken) {
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

app.post("/auth/reset-senha", async (c) => {
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

    await client.query("BEGIN");

    await client.query(
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

    await client.query(
      `
      UPDATE password_reset_tokens
      SET usado_em = NOW()
      WHERE usuario_id = $1
      AND usado_em IS NULL
      `,
      [resetToken.usuario_id]
    );

    await client.query("COMMIT");

    return c.json({
      success: true,
      message: "Senha alterada com sucesso"
    });

  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});

    console.error("RESET PASSWORD ERROR:", err);

    return c.json({
      error: "Erro ao alterar senha"
    }, 500);
  }
});

app.get("/login-test", async (c) => {
  try {
    const email = c.req.query("email");
    const senha = c.req.query("senha");

    if (!email || !senha) {
      return c.json({ error: "Email e senha obrigatórios" }, 400);
    }

    const result = await client.query(
      `
      SELECT id, email, senha, tipo, nome, sobrenome
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
  const { email, senha } = await c.req.json();

  const result = await client.query(
    `
    SELECT id, email, senha, tipo, nome, sobrenome
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

app.put("/usuarios/me/senha", authMiddleware, async (c) => {

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

    const novaSenhaHash = await gerarHashSenha(nova_senha);

    await client.query(
      `
      UPDATE usuarios
      SET senha = $1
      WHERE id = $2
      `,
      [novaSenhaHash, user.id]
    );

    return c.json({
      sucesso: true
    });

  } catch (err) {

    console.error("ERRO TROCAR SENHA:", err);

    return c.json({
      error: "Erro ao trocar senha"
    }, 500);
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

    const campanhas = await client.query(
      `
      SELECT *
      FROM campanhas
      WHERE usuario_id = $1
      ORDER BY id DESC
      `,
      [user.id]
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

// 📊 métricas reais das campanhas
app.get("/meta/metricas-campanhas", authMiddleware, async (c) => {

  try {

    const user: any = c.get("user");

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
      return c.json({ error: "Meta não conectada" }, 400);
    }

    const token = conn.rows[0].access_token;

    const campanhas = await client.query(
      `
      SELECT *
      FROM campanhas
      WHERE usuario_id = $1
      ORDER BY id DESC
      `,
      [user.id]
    );

    const metricas = [];

    for (const campanha of campanhas.rows) {

      if (!campanha.campaign_id) {
        continue;
      }

      const insights = await fetch(
        `https://graph.facebook.com/v19.0/${campanha.campaign_id}/insights?fields=impressions,clicks,spend,cpc,ctr,reach,actions,cost_per_action_type&time_increment=1&date_preset=last_7d&access_token=${token}`
      ).then(r => r.json());

      console.log("INSIGHTS:", insights);

      const dados = insights.data?.[0] || {};

      const grafico =
        insights.data?.map((d: any) => ({
          data: d.date_start,
          clicks: Number(d.clicks || 0),
          ctr: Number(d.ctr || 0),
          gasto: Number(d.spend || 0),
          impressoes: Number(d.impressions || 0)
        })) || [];

      // ✅ LEADS REAIS DO BANCO
      const leadsBanco = await client.query(
        `
        SELECT COUNT(*) AS total
        FROM leads
        WHERE usuario_id = $1
        AND campanha = $2
        `,
        [
          user.id,
          campanha.nome
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
        criado_em: campanha.criado_em
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
      SELECT access_token
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
      await obterContaAnuncios(token);
    
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
            atualizado_em = NOW()
          WHERE campaign_id = $3
          `,
          [
            campanha.name,
            statusFinal,
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
            nome,
            status,
            origem,
            atualizado_em
          )
          VALUES ($1,$2,$3,$4,$5,NOW())
          `,
          [
            user.id,
            campanha.id,
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
        JSON.stringify(forms, null, 2)
      );

      for (const form of forms.data || []) {

        // 🔥 BUSCA CAMPANHA PELO FORM
        const campanhaBanco = await client.query(
          `
          SELECT nome
          FROM campanhas
          WHERE form_id = $1
          LIMIT 1
          `,
          [form.id]
        );
        
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
          JSON.stringify(leadsMeta, null, 2)
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
                respostas_qualificacao = $2
              WHERE lead_id = $3
              AND usuario_id = $4
              `,
              [
                nomeCampanha,
                JSON.stringify(respostasQualificacao),
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
              origem,
              status,
              respostas_qualificacao,
              criado_em
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()
            )
            `,
            [
              user.id,
              lead.id,
              fields.full_name || "",
              fields.email || "",
              fields.phone_number || "",
              nomeCampanha,
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


    const campanhaBanco = await client.query(
      `
      SELECT adset_id, ad_id
      FROM campanhas
      WHERE campaign_id = $1
      LIMIT 1
      `,
      [campaign_id]
    );
    
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
      WHERE campaign_id = $2
      `,
      [status, campaign_id]
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
      WHERE campaign_id = $1
      `,
      [campaign_id]
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
      ORDER BY criado_em DESC
      `,
      [user.id]
    );

    // 🔥 separa por status
    const leads = {
      novos: [],
      primeiro_contato: [],
      em_conversa: [],
      fechado: [],
      perdido: []
    };
    
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
        u.admin_id,
        admin.email AS admin_email,
        COALESCE(u.ativo, true) AS ativo,
        COUNT(DISTINCT c.id) AS campanhas,
        COUNT(DISTINCT l.id) AS leads
      FROM usuarios u
      LEFT JOIN usuarios admin
        ON admin.id = u.admin_id
      LEFT JOIN campanhas c
        ON c.usuario_id = u.id
      LEFT JOIN leads l
        ON l.usuario_id = u.id
      GROUP BY
        u.id,
        u.email,
        u.tipo,
        u.admin_id,
        admin.email,
        u.ativo
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
      versao_node: process.version
    });

  } catch (err) {

    console.error("ERRO ADMIN RECURSOS:", err);

    return c.json({
      error: "Erro ao buscar recursos"
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
      admin_id
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

    await client.query(
      `
      INSERT INTO usuarios (
        nome,
        sobrenome,
        email,
        senha,
        tipo,
        ativo,
        admin_id
      )
      VALUES (
        $1,$2,$3,$4,$5,true,$6
      )
      `,
      [
        nome,
        sobrenome,
        email,
        senhaHash,
        tipo || "corretor",
        admin_id || null
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

    // 🔒 senha forte
    const senhaForte =
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

    if (!senhaForte.test(nova_senha)) {

      return c.json({
        error:
          "Senha fraca. Use maiúscula, minúscula, número e mínimo 8 caracteres."
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
   🔍 HEALTH
========================= */

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.get("/api/version", (c) => c.json({
  version: "delete-user-route-v1",
  delete_user_route: true
}));

/* =========================
   🚀 START
========================= */

Bun.serve({
  port: Number(Bun.env.PORT) || 3000,
  fetch: app.fetch,
});





