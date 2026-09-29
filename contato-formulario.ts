// Primeiro contato automático por WhatsApp com lead de formulário (Lead Ads da
// Meta, Google, TikTok, LinkedIn). Sem isso o lead de formulário nunca entra
// no fluxo que já funciona pro WhatsApp: não há conversa, a IA não classifica
// o status e nenhum "Qualified Lead" volta pras plataformas (em produção, 64
// leads de formulário e 0 eventos até 2026-09-29).
//
// Fora da janela de 24h a Meta só deixa a empresa iniciar conversa com um
// modelo (template) aprovado. Aceitamos só modelos que dá pra preencher com
// segurança: texto puro, sem variável ou com uma única variável posicional
// {{1}} (primeiro nome do lead), sem mídia no cabeçalho e sem botão com
// variável.

export type ConfigContatoFormulario = {
  ativo: boolean;
  template_nome: string | null;
  template_idioma: string | null;
  template_corpo: string | null;
  template_variaveis: number;
};

export const CONFIG_CONTATO_PADRAO: ConfigContatoFormulario = {
  ativo: false,
  template_nome: null,
  template_idioma: null,
  template_corpo: null,
  template_variaveis: 0
};

export function lerConfigContatoFormulario(valor: unknown): ConfigContatoFormulario {
  const bruto: any = typeof valor === "string" ? (() => { try { return JSON.parse(valor); } catch { return {}; } })() : (valor || {});
  return {
    ativo: bruto.ativo === true,
    template_nome: typeof bruto.template_nome === "string" && bruto.template_nome ? bruto.template_nome : null,
    template_idioma: typeof bruto.template_idioma === "string" && bruto.template_idioma ? bruto.template_idioma : null,
    template_corpo: typeof bruto.template_corpo === "string" ? bruto.template_corpo : null,
    template_variaveis: Number(bruto.template_variaveis) === 1 ? 1 : 0
  };
}

// Só deixa o lead recém-chegado receber a mensagem: a sincronização de
// formulários reimporta leads antigos, e mandar "recebemos seu cadastro"
// semanas depois é ruim pro lead e pra qualidade do número.
export const JANELA_CONTATO_HORAS = 24;

// Plataformas cujo lead vem de formulário nativo (lead_id da própria rede).
const PLATAFORMAS_FORMULARIO = new Set(["meta", "google", "tiktok", "linkedin"]);

export function motivoParaNaoContatar(params: {
  config: ConfigContatoFormulario;
  lead: any;
  criadoNaOrigem?: Date | string | null;
  agora?: Date;
}): string | null {
  const { config, lead } = params;
  const agora = params.agora ?? new Date();

  if (!config.ativo) return "desativado";
  if (!config.template_nome || !config.template_idioma) return "sem modelo escolhido";
  if (!lead) return "lead não encontrado";
  // Formulário nativo das redes (lead_id da própria rede) ou formulário do
  // site do corretor (plataforma 'site', ver site-captura.ts).
  const formularioDeRede = Boolean(lead.lead_id) && PLATAFORMAS_FORMULARIO.has(String(lead.plataforma || ""));
  if (!formularioDeRede && lead.plataforma !== "site") return "não é lead de formulário";
  if (lead.whatsapp_contato_enviado_em) return "já contatado";

  const digitos = String(lead.telefone || "").replace(/\D/g, "");
  if (digitos.length < 10) return "sem telefone válido";

  const criado = new Date(params.criadoNaOrigem ?? lead.criado_em ?? NaN);
  if (!Number.isFinite(criado.getTime())) return "data de criação desconhecida";
  const horas = (agora.getTime() - criado.getTime()) / 3_600_000;
  if (horas > JANELA_CONTATO_HORAS) return "lead antigo";

  return null;
}

// O WhatsApp identifica muitos celulares brasileiros sem o 9º dígito
// (5511 8765-4321 em vez de 5511 98765-4321). Pra achar uma conversa já
// existente com o lead, procura as duas grafias.
export function variantesTelefoneBR(e164: string): string[] {
  const n = String(e164 || "").replace(/\D/g, "");
  if (!n.startsWith("55")) return n ? [n] : [];
  if (n.length === 13 && n[4] === "9") return [n, n.slice(0, 4) + n.slice(5)];
  if (n.length === 12 && /[6-9]/.test(n[4])) return [n, `${n.slice(0, 4)}9${n.slice(4)}`];
  return [n];
}

// Primeiro nome, só letras, com inicial maiúscula. A Meta recusa parâmetro
// vazio, então sem nome utilizável vai "tudo bem" (lê bem em "Olá, {{1}}!").
export function primeiroNomeLead(nome: unknown): string {
  const primeiro = String(nome ?? "")
    .trim()
    .split(/\s+/)[0]
    ?.replace(/[^\p{L}'-]/gu, "") || "";
  if (primeiro.length < 2) return "tudo bem";
  return primeiro.charAt(0).toLocaleUpperCase("pt-BR") + primeiro.slice(1).toLocaleLowerCase("pt-BR");
}

export function renderizarCorpoModelo(corpo: string | null, primeiroNome: string): string {
  return String(corpo || "").replace(/\{\{\s*1\s*\}\}/g, primeiroNome);
}

// Avalia um modelo vindo de GET /{waba_id}/message_templates.
export function avaliarModelo(modelo: any): {
  compativel: boolean;
  motivo: string | null;
  corpo: string | null;
  variaveis: number;
} {
  const componentes: any[] = Array.isArray(modelo?.components) ? modelo.components : [];
  const corpo = componentes.find(c => String(c?.type).toUpperCase() === "BODY")?.text ?? null;
  const variaveisTexto = String(corpo || "").match(/\{\{\s*([^}]+?)\s*\}\}/g) || [];
  const nomes = new Set(variaveisTexto.map(v => v.replace(/[{}\s]/g, "")));
  const base = { corpo, variaveis: nomes.size };

  if (String(modelo?.status).toUpperCase() !== "APPROVED") {
    return { ...base, compativel: false, motivo: "ainda não aprovado pela Meta" };
  }
  if (!corpo) {
    return { ...base, compativel: false, motivo: "sem texto no corpo" };
  }
  if (nomes.size > 1) {
    return { ...base, compativel: false, motivo: "tem mais de uma variável" };
  }
  if (nomes.size === 1 && !nomes.has("1")) {
    return { ...base, compativel: false, motivo: "usa variável com nome (só {{1}} é suportada)" };
  }

  const cabecalho = componentes.find(c => String(c?.type).toUpperCase() === "HEADER");
  if (cabecalho) {
    const formato = String(cabecalho.format || "TEXT").toUpperCase();
    if (formato !== "TEXT") {
      return { ...base, compativel: false, motivo: "cabeçalho com mídia" };
    }
    if (/\{\{/.test(String(cabecalho.text || ""))) {
      return { ...base, compativel: false, motivo: "cabeçalho com variável" };
    }
  }

  const botoes = componentes.find(c => String(c?.type).toUpperCase() === "BUTTONS")?.buttons || [];
  if (botoes.some((b: any) => /\{\{/.test(String(b?.url || "")) || String(b?.type).toUpperCase() === "COPY_CODE" || String(b?.type).toUpperCase() === "OTP")) {
    return { ...base, compativel: false, motivo: "botão que exige preenchimento" };
  }

  return { ...base, compativel: true, motivo: null };
}

export function montarMensagemModelo(params: {
  para: string;
  nome: string;
  idioma: string;
  variaveis: number;
  primeiroNome: string;
}) {
  return {
    messaging_product: "whatsapp",
    to: params.para,
    type: "template",
    template: {
      name: params.nome,
      language: { code: params.idioma },
      ...(params.variaveis === 1
        ? { components: [{ type: "body", parameters: [{ type: "text", text: params.primeiroNome }] }] }
        : {})
    }
  };
}

// Modelo sugerido que a plataforma pode criar na conta do corretor (passa
// pela análise da Meta antes de poder ser usado). UTILITY porque responde a
// um pedido que o próprio lead fez no formulário; a Meta pode reclassificar
// como MARKETING (mensagem mais cara).
export const MODELO_SUGERIDO = {
  name: "primeiro_contato_formulario",
  language: "pt_BR",
  category: "UTILITY",
  components: [
    {
      type: "BODY",
      text: "Olá, {{1}}! Recebemos o seu cadastro e vamos continuar o seu atendimento por aqui. Podemos conversar agora?",
      example: { body_text: [["Maria"]] }
    }
  ]
};
