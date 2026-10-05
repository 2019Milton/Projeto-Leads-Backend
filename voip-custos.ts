export type DirecaoVoip = "entrada" | "saida";

function envNumero(nome: string, padrao: number) {
  const valor = Number(Bun.env[nome]);
  return Number.isFinite(valor) && valor >= 0 ? valor : padrao;
}

export function configuracaoCustosVoip() {
  return {
    numeroMensalUsd: envNumero("VOIP_CUSTO_NUMERO_MENSAL_USD", 4.25),
    sdkMinutoUsd: envNumero("VOIP_CUSTO_SDK_MINUTO_USD", 0.004),
    fixoMinutoUsd: envNumero("VOIP_CUSTO_FIXO_BR_MINUTO_USD", 0.031),
    celularMinutoUsd: envNumero("VOIP_CUSTO_CELULAR_BR_MINUTO_USD", 0.0663),
    entradaMinutoUsd: envNumero("VOIP_CUSTO_ENTRADA_BR_MINUTO_USD", 0.010),
    cotacaoFallback: envNumero("VOIP_USD_BRL_FALLBACK", 5.21),
  };
}

export function tipoDestinoBrasil(telefone: unknown) {
  let digitos = String(telefone ?? "").replace(/\D/g, "");
  if (digitos.startsWith("55")) digitos = digitos.slice(2);
  if (digitos.length === 11 && digitos[2] === "9") return "celular";
  if (digitos.length === 10) return "fixo";
  return "desconhecido";
}

export function estimarCustoChamadaUsd(
  direcao: DirecaoVoip,
  telefone: unknown,
  duracaoSegundos: unknown
) {
  const cfg = configuracaoCustosVoip();
  const segundos = Math.max(Number(duracaoSegundos || 0), 0);
  if (!segundos) return 0;

  // A Twilio normalmente fatura cada perna iniciada da chamada em blocos de minuto.
  const minutosCobrados = Math.max(1, Math.ceil(segundos / 60));

  if (direcao === "entrada") {
    return Number(
      (minutosCobrados * (cfg.entradaMinutoUsd + cfg.sdkMinutoUsd)).toFixed(6)
    );
  }

  const tipo = tipoDestinoBrasil(telefone);
  const tarifaDestino =
    tipo === "fixo" ? cfg.fixoMinutoUsd : cfg.celularMinutoUsd;

  return Number(
    (minutosCobrados * (tarifaDestino + cfg.sdkMinutoUsd)).toFixed(6)
  );
}

export function custoRepasseBrl(
  custoProvedorBrl: number,
  margemPercentual: number,
  taxaFixaMensalBrl: number
) {
  const custo = Math.max(Number(custoProvedorBrl || 0), 0);
  const margem = Math.max(Number(margemPercentual || 0), 0);
  const taxa = Math.max(Number(taxaFixaMensalBrl || 0), 0);
  return Number((custo * (1 + margem / 100) + taxa).toFixed(2));
}

export function normalizarMesVoip(valor: unknown) {
  const texto = String(valor || "").trim();
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(texto)) return texto;
  const hoje = new Date();
  return `${hoje.getUTCFullYear()}-${String(hoje.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function intervaloMesVoip(mes: string) {
  const [ano, numeroMes] = normalizarMesVoip(mes).split("-").map(Number);
  const inicio = new Date(Date.UTC(ano, numeroMes - 1, 1));
  const fim = new Date(Date.UTC(ano, numeroMes, 1));
  return { inicio, fim };
}
