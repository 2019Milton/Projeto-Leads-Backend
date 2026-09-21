// Lógica pura do ranking de plataformas de anúncio (selos da tela de Integrações).
//
// O ranking combina três fontes, da mais genérica para a mais específica:
//   1. Pesquisa na internet: nota de mercado por nicho, atualizada toda semana por
//      uma busca com IA (ver executarRankingMercado no index.ts). Aqui ficam as
//      travas que impedem uma resposta ruim da IA de virar o ranking.
//   2. Rede de clientes: resultado agregado e anônimo de todos os clientes da
//      plataforma no mesmo nicho (leads, fechamento, custo por lead, CTR).
//   3. A própria conta: calculada no front, com o histórico do usuário.
//
// Nada aqui acessa banco, rede ou variáveis de ambiente, para poder ser testado.

export const PLATAFORMAS_RANKING = [
  "meta",
  "google",
  "tiktok",
  "linkedin",
  "kwai",
  "pinterest",
  "snapchat",
  "microsoft",
] as const;

export type PlataformaRanking = (typeof PLATAFORMAS_RANKING)[number];
export type NotasPorPlataforma = Record<PlataformaRanking, number>;

// A nota de mercado de uma plataforma só pode andar até este valor por atualização
// semanal, para uma resposta isolada da IA não embaralhar o ranking.
export const VARIACAO_MAXIMA_MERCADO = 8;

// Mínimo de plataformas com nota numa resposta da IA para ela ser aceita.
export const MINIMO_PLATAFORMAS_RESPOSTA = 5;

// Privacidade: dados da rede só entram no ranking quando há contas e leads
// suficientes para nenhum cliente ser identificável.
export const MINIMO_CONTAS_REDE = 3;
export const MINIMO_LEADS_REDE = 20;

// Notas de partida por nicho (0 a 100). São estimativas internas de adequação
// estratégica, não benchmarks medidos. Servem de referência para a IA e como reserva
// quando a pesquisa falha. Espelham HUB_RANKING_MERCADO do front (index.html).
export const NOTAS_BASE_MERCADO: Record<string, NotasPorPlataforma> = {
  geral:         { meta: 88, google: 90, tiktok: 76, linkedin: 72, kwai: 62, pinterest: 60, snapchat: 55, microsoft: 65 },
  imoveis:       { meta: 94, google: 92, tiktok: 76, linkedin: 62, kwai: 60, pinterest: 68, snapchat: 55, microsoft: 64 },
  saude:         { meta: 88, google: 90, tiktok: 60, linkedin: 65, kwai: 45, pinterest: 55, snapchat: 40, microsoft: 63 },
  suplementos:   { meta: 90, google: 88, tiktok: 86, linkedin: 42, kwai: 70, pinterest: 75, snapchat: 65, microsoft: 55 },
  plataforma:    { meta: 84, google: 94, tiktok: 72, linkedin: 92, kwai: 45, pinterest: 50, snapchat: 45, microsoft: 78 },
  higienizacao:  { meta: 88, google: 95, tiktok: 65, linkedin: 60, kwai: 55, pinterest: 50, snapchat: 42, microsoft: 70 },
  telecom:       { meta: 86, google: 95, tiktok: 65, linkedin: 92, kwai: 50, pinterest: 40, snapchat: 35, microsoft: 78 },
  cursos_online: { meta: 91, google: 90, tiktok: 88, linkedin: 75, kwai: 60, pinterest: 62, snapchat: 55, microsoft: 65 },
  educacao:      { meta: 90, google: 92, tiktok: 85, linkedin: 76, kwai: 58, pinterest: 64, snapchat: 54, microsoft: 66 },
  automoveis:    { meta: 91, google: 94, tiktok: 80, linkedin: 55, kwai: 60, pinterest: 65, snapchat: 55, microsoft: 70 },
  consorcio:     { meta: 90, google: 93, tiktok: 74, linkedin: 60, kwai: 55, pinterest: 50, snapchat: 45, microsoft: 68 },
};

const ALIASES_NICHO: Record<string, string> = {
  saas: "plataforma",
  plataforma_saas: "plataforma",
  planos_de_saude: "saude",
  telecom_empresarial: "telecom",
  cursos: "cursos_online",
  automoveis_veiculos: "automoveis",
};

export function normalizarSlugNicho(slug: unknown): string {
  const chave = String(slug ?? "geral")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const normalizado = ALIASES_NICHO[chave] || chave;
  return NOTAS_BASE_MERCADO[normalizado] ? normalizado : "geral";
}

export function notasBaseDoNicho(slug: unknown): NotasPorPlataforma {
  return NOTAS_BASE_MERCADO[normalizarSlugNicho(slug)] || NOTAS_BASE_MERCADO.geral!;
}

export function limitarNota(valor: number, minimo = 0, maximo = 100): number {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return minimo;
  return Math.max(minimo, Math.min(maximo, numero));
}

function arredondar1(valor: number): number {
  return Math.round(valor * 10) / 10;
}

function ehPlataformaRanking(valor: unknown): valor is PlataformaRanking {
  return typeof valor === "string" && (PLATAFORMAS_RANKING as readonly string[]).includes(valor);
}

// ---------------------------------------------------------------------------
// 1. Pesquisa na internet
// ---------------------------------------------------------------------------

// Mantém a nota nova a no máximo `variacaoMaxima` pontos da referência anterior.
export function aplicarTravaVariacao(
  notaNova: number,
  notaAnterior: number,
  variacaoMaxima = VARIACAO_MAXIMA_MERCADO
): number {
  const referencia = limitarNota(notaAnterior);
  const dentroDaTrava = Math.max(
    referencia - variacaoMaxima,
    Math.min(referencia + variacaoMaxima, limitarNota(notaNova))
  );
  return arredondar1(limitarNota(dentroDaTrava));
}

export interface NotaMercadoResposta {
  plataforma: PlataformaRanking;
  nota: number;
  motivo: string;
}

// Lê o JSON devolvido pela IA e descarta tudo que não for confiável: plataforma
// desconhecida, nota que não é número, plataforma repetida.
export function extrairNotasMercado(resposta: unknown): NotaMercadoResposta[] {
  const lista = (resposta as { notas?: unknown } | null)?.notas;
  if (!Array.isArray(lista)) return [];

  const vistas = new Set<PlataformaRanking>();
  const notas: NotaMercadoResposta[] = [];

  for (const item of lista) {
    const plataforma = String((item as any)?.plataforma ?? "").trim().toLowerCase();
    const nota = Number((item as any)?.nota);
    if (!ehPlataformaRanking(plataforma) || vistas.has(plataforma)) continue;
    if (!Number.isFinite(nota)) continue;

    vistas.add(plataforma);
    notas.push({
      plataforma,
      nota: limitarNota(nota),
      motivo: String((item as any)?.motivo ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
    });
  }
  return notas;
}

export interface NotaMercadoFinal {
  plataforma: PlataformaRanking;
  nota: number;
  notaBruta: number;
  motivo: string;
}

// Aplica a trava de variação sobre a nota anterior (ou, na primeira vez, sobre a nota
// de partida do nicho). Devolve lista vazia quando a resposta não parece confiável:
// poucas plataformas ou todas com quase a mesma nota.
export function combinarNotasMercado(
  respostas: NotaMercadoResposta[],
  anteriores: Partial<Record<PlataformaRanking, number>>,
  base: NotasPorPlataforma
): NotaMercadoFinal[] {
  if (respostas.length < MINIMO_PLATAFORMAS_RESPOSTA) return [];
  const notasDistintas = new Set(respostas.map((r) => Math.round(r.nota / 2)));
  if (notasDistintas.size < 3) return [];

  return respostas.map((resposta) => {
    const referencia = anteriores[resposta.plataforma] ?? base[resposta.plataforma];
    return {
      plataforma: resposta.plataforma,
      nota: aplicarTravaVariacao(resposta.nota, referencia),
      notaBruta: arredondar1(resposta.nota),
      motivo: resposta.motivo,
    };
  });
}

// ---------------------------------------------------------------------------
// 2. Rede de clientes (dados agregados e anônimos)
// ---------------------------------------------------------------------------

// Uma linha por nicho e plataforma, somando todos os clientes.
export interface LinhaRedeBruta {
  nicho: string;
  plataforma: string;
  contas: number;        // contas distintas com lead ou gasto
  leads: number;
  qualificados: number;
  fechados: number;
  contas_gasto: number;  // contas com gasto registrado
  gasto: number;
  leads_gasto: number;   // leads das contas que tiveram gasto
  cliques: number;
  impressoes: number;
}

export interface NotaRede {
  nota: number;   // 0 a 100, comparativa entre as plataformas do mesmo nicho
  peso: number;   // 0 a 1, o quanto a amostra da rede merece pesar no ranking
  contas: number;
  leads: number;
}

export type RedePorNicho = Record<string, Partial<Record<PlataformaRanking, NotaRede>>>;

const PESOS_DESEMPENHO = { custo: 0.45, qualidade: 0.3, volume: 0.15, engajamento: 0.1 };

function pesoConfiancaRede(contas: number, leads: number): number {
  if (contas >= 10 && leads >= 200) return 0.7;
  if (contas >= 5 && leads >= 100) return 0.55;
  if (contas >= 4 && leads >= 50) return 0.4;
  return 0.25;
}

export function amostraRedeSuficiente(linha: Pick<LinhaRedeBruta, "contas" | "leads">): boolean {
  return Number(linha.contas) >= MINIMO_CONTAS_REDE && Number(linha.leads) >= MINIMO_LEADS_REDE;
}

// Compara as plataformas de cada nicho entre si. Um nicho só entra quando pelo menos
// duas plataformas têm amostra suficiente; com uma só, "melhor" e "pior" não existem
// e a nota dela ficaria inflada por falta de comparação.
export function calcularNotasRede(linhas: LinhaRedeBruta[]): RedePorNicho {
  const porNicho = new Map<string, LinhaRedeBruta[]>();
  for (const linha of linhas) {
    if (!ehPlataformaRanking(linha.plataforma) || !amostraRedeSuficiente(linha)) continue;
    const lista = porNicho.get(linha.nicho) || [];
    lista.push(linha);
    porNicho.set(linha.nicho, lista);
  }

  const resultado: RedePorNicho = {};

  for (const [nicho, lista] of porNicho) {
    if (lista.length < 2) continue;

    const cplDe = (l: LinhaRedeBruta): number | null =>
      Number(l.contas_gasto) >= MINIMO_CONTAS_REDE &&
      Number(l.leads_gasto) >= MINIMO_LEADS_REDE &&
      Number(l.gasto) > 0
        ? Number(l.gasto) / Number(l.leads_gasto)
        : null;

    const cpls = lista.map(cplDe).filter((v): v is number => v !== null && v > 0);
    const menorCpl = cpls.length ? Math.min(...cpls) : null;
    const maiorVolume = Math.max(1, ...lista.map((l) => Number(l.leads)));

    const notas: Partial<Record<PlataformaRanking, NotaRede>> = {};

    for (const linha of lista) {
      const leads = Number(linha.leads);
      const taxaQualificacao = (Number(linha.qualificados) / leads) * 100;
      const taxaFechamento = (Number(linha.fechados) / leads) * 100;
      const cpl = cplDe(linha);
      const impressoes = Number(linha.impressoes);
      const ctr = impressoes > 0 ? (Number(linha.cliques) / impressoes) * 100 : null;

      const componentes: Array<[number, number]> = [
        [limitarNota(taxaQualificacao * 0.72 + Math.min(100, taxaFechamento * 3) * 0.28), PESOS_DESEMPENHO.qualidade],
        [limitarNota((Math.log1p(leads) / Math.log1p(maiorVolume)) * 100), PESOS_DESEMPENHO.volume],
      ];
      if (cpl && menorCpl) componentes.push([limitarNota((menorCpl / cpl) * 100), PESOS_DESEMPENHO.custo]);
      if (ctr !== null) componentes.push([limitarNota((ctr / 2) * 100), PESOS_DESEMPENHO.engajamento]);

      // Componentes sem dado (ex.: sem gasto registrado) saem da conta e os pesos
      // restantes são reescalados, em vez de valerem zero.
      const somaPesos = componentes.reduce((total, [, peso]) => total + peso, 0);
      const desempenho = componentes.reduce((total, [valor, peso]) => total + valor * peso, 0) / somaPesos;

      notas[linha.plataforma as PlataformaRanking] = {
        nota: arredondar1(desempenho),
        peso: pesoConfiancaRede(Number(linha.contas), leads),
        contas: Number(linha.contas),
        leads,
      };
    }
    resultado[nicho] = notas;
  }

  return resultado;
}

// ---------------------------------------------------------------------------
// Histórico diário de gasto (alimenta o custo por lead da rede)
// ---------------------------------------------------------------------------

export interface DiaDesempenho {
  data: string;
  gasto: number;
  cliques: number;
  impressoes: number;
}

// Lê `dias` de /<plataforma>/performance-diaria e mantém só os dias com movimento.
export function extrairDiasDesempenho(resposta: unknown): DiaDesempenho[] {
  const dias = (resposta as { dias?: unknown } | null)?.dias;
  if (!Array.isArray(dias)) return [];

  const resultado: DiaDesempenho[] = [];
  for (const dia of dias) {
    const data = String((dia as any)?.data ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) continue;

    const gasto = Number((dia as any)?.gasto ?? 0);
    const cliques = Number((dia as any)?.cliques ?? 0);
    const impressoes = Number((dia as any)?.impressoes ?? 0);
    if (![gasto, cliques, impressoes].every(Number.isFinite)) continue;
    if (gasto <= 0 && cliques <= 0 && impressoes <= 0) continue;

    resultado.push({
      data,
      gasto: Math.max(0, Math.round(gasto * 100) / 100),
      cliques: Math.max(0, Math.round(cliques)),
      impressoes: Math.max(0, Math.round(impressoes)),
    });
  }
  return resultado;
}
