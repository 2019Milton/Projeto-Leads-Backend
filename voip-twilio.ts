import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

export type ConfiguracaoTwilioVoip = {
  accountSid: string;
  authToken: string;
  apiKeySid: string;
  apiKeySecret: string;
  bundleSid: string;
  addressSid: string;
  provisionamentoHabilitado: boolean;
  dddPadrao: string;
};

function env(nome: string) {
  return String(Bun.env[nome] || "").trim();
}

function envBool(nome: string, padrao = false) {
  const valor = env(nome).toLowerCase();
  if (!valor) return padrao;
  return ["1", "true", "yes", "sim", "on"].includes(valor);
}

export function configuracaoTwilioVoip(): ConfiguracaoTwilioVoip {
  return {
    accountSid: env("TWILIO_ACCOUNT_SID"),
    authToken: env("TWILIO_AUTH_TOKEN"),
    apiKeySid: env("TWILIO_API_KEY_SID"),
    apiKeySecret: env("TWILIO_API_KEY_SECRET"),
    bundleSid: env("TWILIO_BRAZIL_BUNDLE_SID"),
    addressSid: env("TWILIO_ADDRESS_SID"),
    provisionamentoHabilitado: envBool("VOIP_PROVISIONING_ENABLED", false),
    dddPadrao: env("VOIP_DEFAULT_DDD") || "11",
  };
}

export function diagnosticarTwilioVoip() {
  const cfg = configuracaoTwilioVoip();
  const faltantes: string[] = [];

  if (!cfg.accountSid) faltantes.push("TWILIO_ACCOUNT_SID");
  if (!cfg.authToken) faltantes.push("TWILIO_AUTH_TOKEN");
  if (!cfg.apiKeySid) faltantes.push("TWILIO_API_KEY_SID");
  if (!cfg.apiKeySecret) faltantes.push("TWILIO_API_KEY_SECRET");

  const avisos: string[] = [];
  if (!cfg.bundleSid) avisos.push("TWILIO_BRAZIL_BUNDLE_SID");
  if (!cfg.addressSid) avisos.push("TWILIO_ADDRESS_SID");

  return {
    provedor: "twilio",
    configurado: faltantes.length === 0,
    faltantes,
    avisos,
    provisionamento_habilitado: cfg.provisionamentoHabilitado,
    ddd_padrao: cfg.dddPadrao,
  };
}

function authHeader(cfg: ConfiguracaoTwilioVoip) {
  return `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`;
}

async function respostaTwilio(res: Response) {
  const texto = await res.text();
  let dados: any = {};
  try {
    dados = texto ? JSON.parse(texto) : {};
  } catch {
    dados = { raw: texto };
  }

  if (!res.ok) {
    const mensagem =
      dados?.message ||
      dados?.detail ||
      dados?.error ||
      `Twilio HTTP ${res.status}`;
    const erro: any = new Error(String(mensagem));
    erro.status = res.status;
    erro.codigo = dados?.code || null;
    erro.detalhe = dados;
    throw erro;
  }

  return dados;
}

async function twilioFetch(
  caminho: string,
  init: RequestInit = {},
  cfg = configuracaoTwilioVoip()
) {
  if (!cfg.accountSid || !cfg.authToken) {
    throw new Error("Credenciais da Twilio não configuradas");
  }

  const headers = new Headers(init.headers || {});
  headers.set("Authorization", authHeader(cfg));

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}${caminho}`, {
    ...init,
    headers,
  });

  return respostaTwilio(res);
}

export function normalizarNumeroBrasilVoip(valor: unknown): string | null {
  let digitos = String(valor ?? "").replace(/\D/g, "");
  if (!digitos) return null;

  if (digitos.startsWith("55")) {
    digitos = digitos.slice(2);
  }

  if (digitos.length !== 10 && digitos.length !== 11) return null;
  const ddd = digitos.slice(0, 2);
  if (!/^[1-9]\d$/.test(ddd)) return null;

  return `+55${digitos}`;
}

export function validarDddBrasil(valor: unknown): string | null {
  const ddd = String(valor ?? "").replace(/\D/g, "");
  if (!/^[1-9]\d$/.test(ddd)) return null;
  return ddd;
}

export async function prepararTwimlAppTwilio(
  sidExistente: string | null,
  voiceUrl: string
) {
  const cfg = configuracaoTwilioVoip();
  const corpo = new URLSearchParams({
    FriendlyName: "Plataforma de Leads - VoIP",
    VoiceUrl: voiceUrl,
    VoiceMethod: "POST",
  });

  if (sidExistente) {
    const dados = await twilioFetch(
      `/Applications/${encodeURIComponent(sidExistente)}.json`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: corpo,
      },
      cfg
    );
    return String(dados?.sid || sidExistente);
  }

  const dados = await twilioFetch(
    "/Applications.json",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: corpo,
    },
    cfg
  );

  if (!dados?.sid) {
    throw new Error("A Twilio não devolveu o SID do TwiML App");
  }

  return String(dados.sid);
}

export async function buscarNumeroLocalBrasilTwilio(ddd: string) {
  const cfg = configuracaoTwilioVoip();
  const dddValido = validarDddBrasil(ddd);
  if (!dddValido) throw new Error("DDD inválido");

  const query = new URLSearchParams({
    AreaCode: dddValido,
    VoiceEnabled: "true",
    PageSize: "10",
  });

  const dados = await twilioFetch(
    `/AvailablePhoneNumbers/BR/Local.json?${query.toString()}`,
    { method: "GET" },
    cfg
  );

  const numeros = Array.isArray(dados?.available_phone_numbers)
    ? dados.available_phone_numbers
    : [];

  const escolhido = numeros.find((item: any) => item?.phone_number);
  if (!escolhido?.phone_number) {
    throw new Error(`Nenhum número local com DDD ${dddValido} está disponível na Twilio agora`);
  }

  return {
    numero: String(escolhido.phone_number),
    nome: String(escolhido.friendly_name || escolhido.phone_number),
    localidade: escolhido.locality || null,
    regiao: escolhido.region || null,
  };
}

export async function provisionarNumeroLocalBrasilTwilio(params: {
  ddd: string;
  voiceUrl: string;
  friendlyName: string;
}) {
  const cfg = configuracaoTwilioVoip();

  if (!cfg.provisionamentoHabilitado) {
    const erro: any = new Error(
      "O provisionamento VoIP está travado globalmente. Ative VOIP_PROVISIONING_ENABLED somente quando quiser permitir contratação de números."
    );
    erro.codigo = "VOIP_PROVISIONING_DISABLED";
    throw erro;
  }

  const disponivel = await buscarNumeroLocalBrasilTwilio(params.ddd);
  const corpo = new URLSearchParams({
    PhoneNumber: disponivel.numero,
    FriendlyName: params.friendlyName,
    VoiceUrl: params.voiceUrl,
    VoiceMethod: "POST",
  });

  if (cfg.bundleSid) corpo.set("BundleSid", cfg.bundleSid);
  if (cfg.addressSid) corpo.set("AddressSid", cfg.addressSid);

  const dados = await twilioFetch(
    "/IncomingPhoneNumbers.json",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: corpo,
    },
    cfg
  );

  if (!dados?.sid || !dados?.phone_number) {
    throw new Error("A Twilio não confirmou a contratação do número");
  }

  return {
    sid: String(dados.sid),
    numero: String(dados.phone_number),
    friendly_name: dados.friendly_name || params.friendlyName,
  };
}

export async function liberarNumeroTwilio(numeroSid: string) {
  const cfg = configuracaoTwilioVoip();
  if (!numeroSid) throw new Error("SID do número não informado");

  await twilioFetch(
    `/IncomingPhoneNumbers/${encodeURIComponent(numeroSid)}.json`,
    { method: "DELETE" },
    cfg
  );

  return { ok: true };
}

function base64UrlJson(valor: any) {
  return Buffer.from(JSON.stringify(valor), "utf8").toString("base64url");
}

export function criarTokenTwilioVoice(params: {
  identity: string;
  twimlAppSid: string;
  ttlSegundos?: number;
}) {
  const cfg = configuracaoTwilioVoip();

  if (!cfg.accountSid || !cfg.apiKeySid || !cfg.apiKeySecret) {
    throw new Error("Credenciais do Voice SDK da Twilio não configuradas");
  }
  if (!params.twimlAppSid) {
    throw new Error("TwiML App do VoIP ainda não foi configurado");
  }

  const agora = Math.floor(Date.now() / 1000);
  const ttl = Math.min(Math.max(Number(params.ttlSegundos || 3600), 300), 3600);
  const header = {
    typ: "JWT",
    alg: "HS256",
    cty: "twilio-fpa;v=1",
  };
  const payload = {
    jti: `${cfg.apiKeySid}-${agora}-${Math.random().toString(36).slice(2, 10)}`,
    grants: {
      identity: params.identity,
      voice: {
        incoming: { allow: true },
        outgoing: {
          application_sid: params.twimlAppSid,
        },
      },
    },
    iat: agora,
    exp: agora + ttl,
    iss: cfg.apiKeySid,
    sub: cfg.accountSid,
  };

  const cabecalho = base64UrlJson(header);
  const corpo = base64UrlJson(payload);
  const assinatura = createHmac("sha256", cfg.apiKeySecret)
    .update(`${cabecalho}.${corpo}`)
    .digest("base64url");

  return `${cabecalho}.${corpo}.${assinatura}`;
}

export function validarAssinaturaTwilio(
  urlExata: string,
  parametros: Record<string, any>,
  assinaturaRecebida: string | null | undefined
) {
  const cfg = configuracaoTwilioVoip();
  if (!cfg.authToken || !assinaturaRecebida) return false;

  let base = urlExata;
  for (const chave of Object.keys(parametros || {}).sort()) {
    const valor = parametros[chave];
    if (Array.isArray(valor)) {
      for (const item of valor) base += `${chave}${String(item ?? "")}`;
    } else {
      base += `${chave}${String(valor ?? "")}`;
    }
  }

  const esperada = createHmac("sha1", cfg.authToken)
    .update(base)
    .digest("base64");

  const a = Buffer.from(String(assinaturaRecebida));
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function escaparXmlVoip(valor: unknown) {
  return String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
