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

// Script servido em GET /site/form.js?k=<chave>. Sem dependências; descobre a
// API pelo próprio src. Atributos opcionais no <script>: data-botao,
// data-cor, data-sucesso, data-campanha, data-sem-formulario (só captura e
// expõe PlataformaLeads.enviar pra formulário próprio do site).
export function scriptFormularioSite(): string {
  return `(function () {
  var script = document.currentScript;
  if (!script) return;
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

  function origem() {
    var salvo = ler();
    if (salvo.capturado_em && Date.now() - salvo.capturado_em > 90 * 864e5) salvo = {};
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
