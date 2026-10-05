// Captação de leads do SITE do corretor (campanhas com destino "site").
// Antes não havia caminho nenhum: o lead que preenchia o formulário do site
// não entrava na plataforma, e nenhum sinal de qualidade voltava pras redes.
//
// O corretor cola no site um <script> (ver scriptFormularioSite) que:
// - guarda os identificadores do clique que trouxe o visitante (fbclid,
//   gclid, ttclid, li_fat_id, UTMs) assim que ele chega na página;
// - desenha um formulário simples (ou expõe PlataformaLeads.enviar pra quem
//   já tem formulário próprio) e envia pra POST /site/leads.
// Com o identificador do clique, o lead entra atribuído à rede certa e os
// eventos de qualificação/venda voltam pra ela.

export type RedeSite = "meta" | "google" | "tiktok" | "linkedin" | "site";

const CHAVES_ATRIBUICAO = [
  "fbclid", "fbc", "fbp", "gclid", "gbraid", "wbraid", "ttclid", "li_fat_id",
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
  "pagina", "referrer"
] as const;

export type AtribuicaoSite = Partial<Record<(typeof CHAVES_ATRIBUICAO)[number], string>> & {
  ip?: string;
  user_agent?: string;
  capturado_em?: string;
};

function texto(valor: unknown, limite: number): string {
  return String(valor ?? "").replace(/\p{Cc}/gu, " ").trim().slice(0, limite);
}

// Só as chaves conhecidas, em texto curto — o corpo vem de um site público.
export function normalizarAtribuicao(bruto: unknown): AtribuicaoSite {
  const origem: any = bruto && typeof bruto === "object" ? bruto : {};
  const saida: AtribuicaoSite = {};
  for (const chave of CHAVES_ATRIBUICAO) {
    const valor = texto(origem[chave], chave === "pagina" || chave === "referrer" ? 500 : 300);
    if (valor) saida[chave] = valor;
  }
  return saida;
}

// Formato do cookie _fbc da Meta, montado a partir do fbclid da URL quando o
// site não tem o pixel instalado: fb.1.<milissegundos>.<fbclid>.
export function montarFbc(fbclid: string, agoraMs: number): string {
  return `fb.1.${agoraMs}.${fbclid}`;
}

const REDE_POR_UTM: Record<string, RedeSite> = {
  facebook: "meta", fb: "meta", instagram: "meta", ig: "meta", meta: "meta",
  google: "google", "google-ads": "google", adwords: "google",
  tiktok: "tiktok",
  linkedin: "linkedin"
};

// Identificador do clique é prova de origem; utm_source é só indicação
// (vale quando não há identificador).
export function detectarRedeSite(atr: AtribuicaoSite): RedeSite {
  if (atr.gclid || atr.gbraid || atr.wbraid) return "google";
  if (atr.fbclid || atr.fbc) return "meta";
  if (atr.ttclid) return "tiktok";
  if (atr.li_fat_id) return "linkedin";
  const utm = String(atr.utm_source || "").toLowerCase().trim();
  return REDE_POR_UTM[utm] || "site";
}

export function validarEnvioSite(corpo: any): {
  ok: boolean;
  erro?: string;
  dados?: { nome: string; telefone: string; email: string | null; mensagem: string | null };
} {
  const nome = texto(corpo?.nome, 120);
  const telefone = String(corpo?.telefone ?? "").replace(/\D/g, "").slice(0, 15);
  const emailBruto = texto(corpo?.email, 160).toLowerCase();
  const email = emailBruto && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailBruto) ? emailBruto : null;
  const mensagem = texto(corpo?.mensagem, 1000) || null;

  if (nome.length < 2) return { ok: false, erro: "Informe seu nome." };
  if (telefone.length < 10) return { ok: false, erro: "Informe um telefone com DDD." };
  if (emailBruto && !email) return { ok: false, erro: "E-mail inválido." };

  return { ok: true, dados: { nome, telefone, email, mensagem } };
}

// Campanha Meta "Direto para o site": otimizar por quem PREENCHE o formulário
// do site (evento padrão Lead no dataset do corretor) em vez de por quem só
// abre a página. Só vale quando o código está instalado — sem ele a Meta não
// recebe nenhum Lead pra aprender e a campanha entrega mal. "Instalado" =
// o script foi carregado por uma página do site nos últimos 30 dias (ver GET
// /site/form.js) ou já chegou lead pelo formulário do site nesse período.
// Vale igual pro Google (Maximizar conversões na ação "Lead do site", que a
// tag do Google dentro do próprio script registra — ver scriptFormularioSite).
export const JANELA_CODIGO_SITE_DIAS = 30;

export function decidirOtimizacaoSiteMeta(params: {
  temRecursoEventos: boolean;
  codigoVistoEm?: Date | string | null;
  ultimoLeadSiteEm?: Date | string | null;
  agora?: Date;
}): { otimizacao: "lead" | "visitas"; motivo: string } {
  const agora = params.agora ?? new Date();
  if (!params.temRecursoEventos) {
    return { otimizacao: "visitas", motivo: "plano sem envio de eventos para a Meta" };
  }
  const recente = (valor?: Date | string | null) => {
    if (!valor) return false;
    const data = new Date(valor);
    return Number.isFinite(data.getTime()) &&
      agora.getTime() - data.getTime() <= JANELA_CODIGO_SITE_DIAS * 86_400_000;
  };
  if (recente(params.codigoVistoEm) || recente(params.ultimoLeadSiteEm)) {
    return { otimizacao: "lead", motivo: "código do formulário instalado no site" };
  }
  return { otimizacao: "visitas", motivo: "código do formulário ainda não detectado no site" };
}

// Domínio da página que carregou o script (cabeçalho Referer). Sem Referer
// (script aberto direto no navegador) não conta como instalado.
export function dominioDoReferer(referer: unknown): string | null {
  try {
    const url = new URL(String(referer ?? ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.hostname.toLowerCase().slice(0, 200) || null;
  } catch {
    return null;
  }
}

function urlHttp(valor: unknown): URL | null {
  try {
    const url = new URL(String(valor ?? "").trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

// Botão da tela de obrigado do formulário da Meta. É ele que faz a opção
// "Formulário + botão para o seu site" da criação de campanha: o lead é
// captado pelo formulário da própria rede (a plataforma recebe nome e
// telefone pela API) e o botão final leva ao site do corretor, sem instalar
// nada no site. Antes, sem link informado, o botão levava a google.com.
// Ordem: link escolhido pro botão (obrigado_url, ou o link do site quando a
// campanha é "formulário + site") → site do anunciante tirado da URL da
// política de privacidade → google.com (legado, só se não houver nada).
export function botaoFinalFormularioMeta(cfg: any): { website_url: string; button_text: string } {
  const doSite = urlHttp(cfg?.obrigado_url) || (cfg?.site_via_formulario ? urlHttp(cfg?.link) : null);
  const textoInformado = String(cfg?.obrigado_botao ?? "").trim();

  if (doSite) {
    return { website_url: doSite.toString(), button_text: textoInformado || "Visitar site" };
  }

  const privacidade = urlHttp(cfg?.privacidade_url || cfg?.url_privacidade);
  return {
    website_url: privacidade ? `${privacidade.origin}/` : "https://google.com",
    button_text: textoInformado || "Ver mais"
  };
}

// Destino da conversão "Lead do site" no Google Ads ("AW-<id da conta>/<rótulo>"),
// lido do trecho de evento que a própria API devolve em
// conversion_action.tag_snippets. Formato estrito porque vai dentro do script
// servido aos sites.
export function validarSendToGoogle(valor: unknown): string | null {
  const texto = String(valor ?? "").trim();
  return /^AW-\d{6,15}\/[A-Za-z0-9_-]{4,64}$/.test(texto) ? texto : null;
}

export function extrairSendToGoogle(tagSnippets: unknown): string | null {
  const lista = Array.isArray(tagSnippets) ? tagSnippets : [];
  for (const snippet of lista) {
    const evento = String(snippet?.eventSnippet ?? snippet?.event_snippet ?? "");
    const achado = evento.match(/send_to['"]?\s*:\s*['"](AW-\d+\/[\w-]+)['"]/);
    const sendTo = validarSendToGoogle(achado?.[1]);
    if (sendTo) return sendTo;
  }
  return null;
}

// Script servido em GET /site/form.js?k=<chave>. Sem dependências; descobre a
// API pelo próprio src. Atributos opcionais no <script>: data-botao,
// data-cor, data-sucesso, data-campanha, data-sem-formulario (só captura e
// expõe PlataformaLeads.enviar pra formulário próprio do site), data-sem-google
// (não carrega a tag do Google).
//
// googleSendTo: com ele, o script registra a conversão "Lead do site" no
// Google Ads a cada envio (a campanha "Direto para o site" do Google otimiza
// por ela). O envio pelo servidor (Data Manager API) depende de uma permissão
// que o Google ainda não liberou pro app; a tag no navegador funciona com o
// que as contas já têm. A tag só é carregada pra quem chegou por anúncio do
// Google (gclid/gbraid/wbraid) — visitante orgânico não recebe cookie do Google.
export function scriptFormularioSite(opcoes: { googleSendTo?: string | null } = {}): string {
  const googleSendTo = validarSendToGoogle(opcoes.googleSendTo) || "";
  return `(function () {
  var script = document.currentScript;
  if (!script) return;
  var GOOGLE_SEND_TO = ${JSON.stringify(googleSendTo)};
  var src = new URL(script.src);
  var api = src.origin;
  var chave = src.searchParams.get("k") || "";
  var ARMAZEM = "plataforma_leads_origem";
  var CHAVES = ["fbclid","gclid","gbraid","wbraid","ttclid","li_fat_id","utm_source","utm_medium","utm_campaign","utm_content","utm_term"];

  function ler() { try { return JSON.parse(localStorage.getItem(ARMAZEM) || "{}"); } catch (e) { return {}; } }
  function gravar(v) { try { localStorage.setItem(ARMAZEM, JSON.stringify(v)); } catch (e) {} }
  function cookie(nome) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + nome + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  // Guarda a origem do clique na chegada (vale por 90 dias; clique novo substitui).
  var params = new URLSearchParams(location.search);
  var novo = {};
  CHAVES.forEach(function (k) { var v = params.get(k); if (v) novo[k] = v.slice(0, 300); });
  if (Object.keys(novo).length) {
    novo.capturado_em = Date.now();
    if (novo.fbclid) novo.fbc = "fb.1." + novo.capturado_em + "." + novo.fbclid;
    gravar(novo);
  }

  function salvoValido() {
    var salvo = ler();
    return salvo.capturado_em && Date.now() - salvo.capturado_em > 90 * 864e5 ? {} : salvo;
  }

  // Tag do Google: a mesma que o Google Ads manda colar no site (gtag.js +
  // config da conta). Na página de chegada ela lê o gclid da URL e guarda no
  // cookie do Google; no envio do formulário, registra a conversão.
  var googleAtivo = false;
  (function () {
    var veio = salvoValido();
    if (!GOOGLE_SEND_TO || script.hasAttribute("data-sem-google")) return;
    if (!(veio.gclid || veio.gbraid || veio.wbraid)) return;
    var tagId = GOOGLE_SEND_TO.split("/")[0];
    window.dataLayer = window.dataLayer || [];
    if (typeof window.gtag !== "function") {
      window.gtag = function () { window.dataLayer.push(arguments); };
    }
    if (!document.querySelector('script[src*="googletagmanager.com/gtag/js"]')) {
      var tag = document.createElement("script");
      tag.async = true;
      tag.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(tagId);
      document.head.appendChild(tag);
      window.gtag("js", new Date());
    }
    window.gtag("config", tagId);
    googleAtivo = true;
  })();

  function origem() {
    var salvo = salvoValido();
    var atr = {};
    CHAVES.forEach(function (k) { if (salvo[k]) atr[k] = salvo[k]; });
    atr.fbc = cookie("_fbc") || salvo.fbc || "";
    atr.fbp = cookie("_fbp") || "";
    atr.pagina = location.href.slice(0, 500);
    atr.referrer = document.referrer.slice(0, 500);
    if (script.getAttribute("data-campanha") && !atr.utm_campaign) atr.utm_campaign = script.getAttribute("data-campanha");
    return atr;
  }

  function enviar(dados) {
    return fetch(api + "/site/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        k: chave,
        nome: dados.nome, telefone: dados.telefone, email: dados.email, mensagem: dados.mensagem,
        hp: dados.hp || "",
        atribuicao: origem()
      })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || "Não foi possível enviar. Tente novamente.");
        // Mesmo event_id do evento enviado pelo servidor: se o site tiver o
        // pixel da Meta, ela descarta a duplicata.
        if (j.event_id && typeof window.fbq === "function") {
          try { window.fbq("track", "Lead", {}, { eventID: j.event_id }); } catch (e) {}
        }
        // transaction_id: envio repetido do mesmo lead não conta duas vezes.
        if (googleAtivo && j.event_id) {
          try { window.gtag("event", "conversion", { send_to: GOOGLE_SEND_TO, transaction_id: j.event_id }); } catch (e) {}
        }
        return j;
      });
    });
  }

  window.PlataformaLeads = { enviar: enviar, origem: origem };
  if (script.hasAttribute("data-sem-formulario")) return;

  var cor = script.getAttribute("data-cor") || "#2563eb";
  var alvo = document.getElementById("plataforma-leads-form");
  if (!alvo) { alvo = document.createElement("div"); script.parentNode.insertBefore(alvo, script.nextSibling); }

  var css = ".pl-form{font:inherit;max-width:420px;display:grid;gap:10px}" +
    ".pl-form label{display:grid;gap:4px;font-size:14px}" +
    ".pl-form input,.pl-form textarea{font:inherit;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;width:100%;box-sizing:border-box}" +
    ".pl-form button{font:inherit;font-weight:600;padding:12px;border:0;border-radius:8px;color:#fff;cursor:pointer}" +
    ".pl-form button[disabled]{opacity:.6;cursor:wait}" +
    ".pl-form .pl-aviso{font-size:12px;opacity:.75;margin:0}" +
    ".pl-form .pl-status{font-size:14px;margin:0}" +
    ".pl-form .pl-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}";
  var estilo = document.createElement("style");
  estilo.textContent = css;
  document.head.appendChild(estilo);

  alvo.innerHTML =
    '<form class="pl-form" novalidate>' +
      '<label>Nome<input name="nome" autocomplete="name" required></label>' +
      '<label>WhatsApp com DDD<input name="telefone" type="tel" inputmode="tel" autocomplete="tel" required></label>' +
      '<label>E-mail (opcional)<input name="email" type="email" autocomplete="email"></label>' +
      '<label>Mensagem (opcional)<textarea name="mensagem" rows="3"></textarea></label>' +
      '<div class="pl-hp" aria-hidden="true"><input name="empresa_site" tabindex="-1" autocomplete="off"></div>' +
      '<p class="pl-aviso">Ao enviar, você concorda em ser contatado por WhatsApp ou telefone.</p>' +
      '<button type="submit"></button>' +
      '<p class="pl-status" role="status"></p>' +
    '</form>';

  var form = alvo.querySelector("form");
  var botao = form.querySelector("button");
  var status = form.querySelector(".pl-status");
  botao.textContent = script.getAttribute("data-botao") || "Enviar";
  botao.style.background = cor;

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    botao.disabled = true;
    status.textContent = "Enviando...";
    enviar({
      nome: form.nome.value, telefone: form.telefone.value, email: form.email.value,
      mensagem: form.mensagem.value, hp: form.empresa_site.value
    }).then(function () {
      form.reset();
      status.textContent = script.getAttribute("data-sucesso") || "Recebemos seus dados! Em breve entraremos em contato.";
    }).catch(function (e) {
      status.textContent = e.message;
    }).then(function () { botao.disabled = false; });
  });
})();
`;
}
