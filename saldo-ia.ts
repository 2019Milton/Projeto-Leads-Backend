// Saldo ESTIMADO dos créditos de IA (OpenAI e Anthropic) para avisar o super
// admin pelo WhatsApp antes de acabar.
//
// Nenhum dos dois provedores expõe o saldo pré-pago por API (conferido em
// 05/10/2026: a Anthropic não tem endpoint de saldo e a conta é individual,
// sem Admin API; a OpenAI só tem o endpoint de custos com chave de admin e o
// antigo /dashboard/billing/credit_grants, que não aceita chave de API). Então:
// o admin informa o saldo que vê no painel do provedor, e a plataforma desconta
// o que ela mesma gastou desde então (ia_usos). Gasto fora da plataforma
// (playground, outro sistema com a mesma conta) não entra — por isso o aviso de
// "sem crédito" de verdade (erro da API) continua sendo a garantia.
//
// Recarga automática (a Anthropic permite: "abaixo de X, recarrega até Y"): a
// plataforma não tem como saber que a recarga aconteceu; quando a estimativa
// cruza X, avisa que ela provavelmente aconteceu e passa a estimar a partir de Y.

export type ConfigSaldoIA = {
  saldoBaseUsd: number;
  gastoDesdeBaseUsd: number;
  alertaAbaixoUsd: number | null;
  recargaAutoAbaixoUsd: number | null;
  recargaAutoAteUsd: number | null;
  alertaBaixoJaEnviado: boolean;
};

export type AvaliacaoSaldoIA = {
  estimadoUsd: number;
  acao: "nenhuma" | "avisar_baixo" | "recarga_automatica";
};

function positivo(valor: number | null | undefined): number | null {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function recargaAutomaticaValida(abaixo: number | null | undefined, ate: number | null | undefined): boolean {
  const a = positivo(abaixo);
  const b = positivo(ate);
  return a !== null && b !== null && b > a;
}

export function avaliarSaldoIA(cfg: ConfigSaldoIA): AvaliacaoSaldoIA {
  const estimadoUsd = Number((Number(cfg.saldoBaseUsd || 0) - Number(cfg.gastoDesdeBaseUsd || 0)).toFixed(4));

  if (recargaAutomaticaValida(cfg.recargaAutoAbaixoUsd, cfg.recargaAutoAteUsd) && estimadoUsd < Number(cfg.recargaAutoAbaixoUsd)) {
    return { estimadoUsd, acao: "recarga_automatica" };
  }

  const limite = positivo(cfg.alertaAbaixoUsd);
  if (limite !== null && estimadoUsd < limite && !cfg.alertaBaixoJaEnviado) {
    return { estimadoUsd, acao: "avisar_baixo" };
  }

  return { estimadoUsd, acao: "nenhuma" };
}

const usd = (valor: number) => `US$ ${Number(valor || 0).toFixed(2).replace(".", ",")}`;

export function mensagemSaldoIA(params: {
  nomeProvedor: string;
  acao: "avisar_baixo" | "recarga_automatica";
  estimadoUsd: number;
  alertaAbaixoUsd?: number | null;
  recargaAutoAbaixoUsd?: number | null;
  recargaAutoAteUsd?: number | null;
  linkBilling: string;
}): { titulo: string; whatsapp: string } {
  if (params.acao === "recarga_automatica") {
    return {
      titulo: `IA: ${params.nomeProvedor} — recarga automática provável`,
      whatsapp:
        `🔄 *${params.nomeProvedor}: recarga automática provavelmente feita*\n\n` +
        `O saldo estimado caiu para ${usd(params.estimadoUsd)}, abaixo de ${usd(Number(params.recargaAutoAbaixoUsd))}, ` +
        `então a recarga automática deve ter levado o saldo a ${usd(Number(params.recargaAutoAteUsd))}. ` +
        `A plataforma passa a estimar a partir desse valor.\n\nConfira a cobrança:\n${params.linkBilling}`
    };
  }
  return {
    titulo: `IA: ${params.nomeProvedor} — saldo baixo`,
    whatsapp:
      `⚠️ *${params.nomeProvedor}: saldo chegando ao fim*\n\n` +
      `Saldo estimado: ${usd(params.estimadoUsd)} (aviso abaixo de ${usd(Number(params.alertaAbaixoUsd))}). ` +
      `Quando acabar, a IA da plataforma passa a usar só o outro provedor.\n\n` +
      `Recarregue aqui e depois atualize o saldo no painel de IA:\n${params.linkBilling}`
  };
}
