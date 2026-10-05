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

const FUSO_VOIP = "America/Sao_Paulo";

export function mesVoipDaData(valor: unknown) {
  const data = valor instanceof Date ? valor : new Date(String(valor ?? ""));
  if (!Number.isFinite(data.getTime())) return null;

  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: FUSO_VOIP,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(data);

  const ano = partes.find((p) => p.type === "year")?.value;
  const mes = partes.find((p) => p.type === "month")?.value;
  return ano && mes ? `${ano}-${mes}` : null;
}

export function normalizarMesVoip(valor: unknown) {
  const texto = String(valor || "").trim();
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(texto)) return texto;

  const atual = mesVoipDaData(new Date());
  if (atual) return atual;

  const hoje = new Date();
  return `${hoje.getUTCFullYear()}-${String(hoje.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function intervaloMesVoip(mes: string) {
  const [ano, numeroMes] = normalizarMesVoip(mes).split("-").map(Number);

  // Financeiro da plataforma usa o calendário de São Paulo. Como o Brasil
  // não usa horário de verão atualmente, 00:00 BRT corresponde a 03:00 UTC.
  const inicio = new Date(`${ano}-${String(numeroMes).padStart(2, "0")}-01T00:00:00-03:00`);

  const proximoAno = numeroMes === 12 ? ano + 1 : ano;
  const proximoMes = numeroMes === 12 ? 1 : numeroMes + 1;
  const fim = new Date(`${proximoAno}-${String(proximoMes).padStart(2, "0")}-01T00:00:00-03:00`);

  return { inicio, fim };
}

function diasNoMesUtc(ano: number, mesZeroBased: number) {
  return new Date(Date.UTC(ano, mesZeroBased + 1, 0)).getUTCDate();
}

function proximaCobrancaNumero(atual: Date) {
  const anoAtual = atual.getUTCFullYear();
  const mesAtual = atual.getUTCMonth();
  const diaAtual = atual.getUTCDate();

  const proximoMesBase = mesAtual + 1;
  const proximoAno = anoAtual + Math.floor(proximoMesBase / 12);
  const proximoMes = ((proximoMesBase % 12) + 12) % 12;
  const dia = Math.min(diaAtual, diasNoMesUtc(proximoAno, proximoMes));

  return new Date(Date.UTC(
    proximoAno,
    proximoMes,
    dia,
    atual.getUTCHours(),
    atual.getUTCMinutes(),
    atual.getUTCSeconds(),
    atual.getUTCMilliseconds()
  ));
}

export function cobrancasNumeroVoipNoMes(params: {
  ativadaEm: unknown;
  liberadaEm?: unknown;
  mes: string;
  custoMensalUsd: unknown;
}) {
  const ativada = new Date(String(params.ativadaEm || ""));
  const liberada = params.liberadaEm
    ? new Date(String(params.liberadaEm))
    : null;
  const custoMensalUsd = Math.max(Number(params.custoMensalUsd || 0), 0);
  const { inicio, fim } = intervaloMesVoip(params.mes);

  if (
    !Number.isFinite(ativada.getTime()) ||
    (liberada && !Number.isFinite(liberada.getTime())) ||
    custoMensalUsd <= 0 ||
    ativada >= fim
  ) {
    return { quantidade: 0, custo_usd: 0, datas: [] as string[] };
  }

  let cobranca = new Date(ativada.getTime());
  const datas: string[] = [];

  // Limite defensivo de 20 anos evita loop infinito com dados corrompidos.
  for (let i = 0; i < 240 && cobranca < fim; i += 1) {
    if (liberada && cobranca >= liberada) break;

    if (cobranca >= inicio) {
      datas.push(cobranca.toISOString());
    }

    cobranca = proximaCobrancaNumero(cobranca);
  }

  return {
    quantidade: datas.length,
    custo_usd: Number((datas.length * custoMensalUsd).toFixed(6)),
    datas,
  };
}
