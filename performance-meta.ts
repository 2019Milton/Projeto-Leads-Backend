// Contagem de leads e calendário do painel de performance da Meta. Nada aqui acessa banco,
// rede ou variáveis de ambiente, para poder ser testado.

// Ordem de preferência entre os nomes que a Meta usa para o mesmo lead (formulário/site):
// eles se repetem na resposta, então só um deles vale.
const TIPOS_LEAD_META = [
  "onsite_conversion.lead_grouped",
  "onsite_conversion.lead",
  "lead",
  "offsite_conversion.fb_pixel_lead",
];

const TIPO_CONVERSA_META = "onsite_conversion.messaging_conversation_started_7d";

function valorDaAction(actions: any[], tipo: string): number | null {
  const item = actions.find(
    (action: any) => String(action?.action_type || "").toLowerCase() === tipo
  );
  return item ? Number(item.value || 0) : null;
}

// Campanha de WhatsApp (Click-to-WhatsApp): o lead é a conversa iniciada. Ela também pode
// trazer uma action "lead", mas essa é um subconjunto bem menor das conversas: na conta do
// usuário 23, 04/11/2026, a Meta devolveu lead = 1 e conversas = 17 na mesma campanha, junto
// com os primeiros QualifiedLead enviados pela plataforma. Dar prioridade à action "lead"
// fazia o CPL saltar de R$ 5 para R$ 156 justamente quando os leads eram qualificados.
//
// Por isso vale o maior dos dois, sem somar (somar contaria o mesmo contato duas vezes):
// - WhatsApp: as conversas superam os poucos "lead";
// - formulário e site: não há conversas, então vale o "lead".
// Com dados só por campanha não dá para separar uma campanha que misture formulário e
// WhatsApp; nesse caso o resultado é o maior dos dois.
export function extrairLeadsActionsMeta(actions: any[] = []): number {
  let leads: number | null = null;
  for (const tipo of TIPOS_LEAD_META) {
    leads = valorDaAction(actions, tipo);
    if (leads !== null) break;
  }

  if (leads === null) {
    leads = actions
      .filter((action: any) =>
        String(action?.action_type || "").toLowerCase().includes("lead")
      )
      .reduce((total: number, action: any) => total + Number(action?.value || 0), 0);
  }

  return Math.max(leads, valorDaAction(actions, TIPO_CONVERSA_META) ?? 0);
}

const FUSO_PAINEL = "America/Sao_Paulo";
const UM_DIA_MS = 24 * 60 * 60 * 1000;

export function diaNoBrasil(agora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO_PAINEL,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora);
}

// Os `dias` últimos dias (YYYY-MM-DD, do mais antigo para hoje) no calendário do Brasil, o
// mesmo das contas de anúncios. O servidor roda em UTC: montar isso com new Date() fazia o
// "hoje" do painel virar o dia seguinte a partir das 21h, com gasto e leads zerados.
export function diasPeriodoBrasil(dias: number, agora: Date = new Date()): string[] {
  return ultimosDiasAte(dias, diaNoBrasil(agora));
}

function ultimosDiasAte(dias: number, hoje: string): string[] {
  const hojeUtc = Date.parse(`${hoje}T00:00:00Z`);
  return Array.from({ length: dias }, (_, indice) =>
    new Date(hojeUtc - (dias - 1 - indice) * UM_DIA_MS).toISOString().slice(0, 10)
  );
}

// Dias de um mês do calendário (AAAA-MM), do dia 1 até o último — ou até hoje, no mês
// corrente. Mês futuro ou inválido: lista vazia.
export function diasDoMes(mes: string, hoje: string): string[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return [];
  const [ano, numeroMes] = mes.split("-").map(Number);
  const ultimoDia = new Date(Date.UTC(ano, numeroMes, 0)).getUTCDate();
  const datas: string[] = [];
  for (let dia = 1; dia <= ultimoDia; dia += 1) {
    const data = `${mes}-${String(dia).padStart(2, "0")}`;
    if (data > hoje) break;
    datas.push(data);
  }
  return datas;
}

export type PeriodoPerformance = "semanal" | "mensal" | "anual" | "mes";

// Período pedido ao painel de performance: os últimos 7, 30 ou 365 dias (o anual vem agrupado
// por mês) ou um mês do calendário (periodo=mes&mes=AAAA-MM), dia a dia. Mês futuro ou
// inválido cai no semanal. `hoje` é o dia que fecha o período: o do Brasil para Meta, Google
// e TikTok; o do UTC para o LinkedIn, cuja Ad Analytics fecha o dia em UTC.
export function periodoPerformanceSolicitado(
  periodoParam: unknown,
  mesParam: unknown,
  hoje: string = diaNoBrasil()
): { periodo: PeriodoPerformance; mes: string | null; dias: number; datas: string[] } {
  const texto = String(periodoParam || "semanal").toLowerCase();

  if (texto === "mes") {
    const mes = String(mesParam || "");
    const datas = diasDoMes(mes, hoje);
    if (datas.length) return { periodo: "mes", mes, dias: datas.length, datas };
  }

  const periodo: PeriodoPerformance =
    texto === "anual" || texto === "mensal" ? texto : "semanal";
  const dias = periodo === "anual" ? 365 : periodo === "mensal" ? 30 : 7;
  return { periodo, mes: null, dias, datas: ultimosDiasAte(dias, hoje) };
}

export type SituacaoCaptacaoPainel = {
  campanhas_importadas: number;
  campanhas_proprias: number;
  codigo_site_visto: boolean;
  whatsapp_conectado: boolean;
};

export type AvisoCaptacaoPainel = Omit<SituacaoCaptacaoPainel, "campanhas_proprias">;

// Gasto no período e nenhum lead salvo. Olha leads_plataforma, e não leads: no painel da Meta,
// leads é o que a própria Meta contabilizou.
export function painelComGastoSemLead(
  dias: Array<{ gasto?: number | null; leads_plataforma?: number | null }> = []
): boolean {
  let gasto = 0;
  let leads = 0;
  for (const dia of dias) {
    gasto += Number(dia?.gasto || 0);
    leads += Number(dia?.leads_plataforma || 0);
  }
  return gasto > 0 && leads === 0;
}

// Só avisa quando todas as campanhas da rede foram importadas: com alguma criada na plataforma,
// não dá para dizer de qual delas veio o gasto sem lead. Com o código no site e o WhatsApp
// conectado, a causa é outra e o aviso não teria o que pedir.
export function avisoCaptacaoImportadas(
  situacao: Partial<SituacaoCaptacaoPainel> | null | undefined
): AvisoCaptacaoPainel | null {
  const campanhasImportadas = Number(situacao?.campanhas_importadas || 0);
  if (campanhasImportadas === 0 || Number(situacao?.campanhas_proprias || 0) > 0) return null;

  const codigoSiteVisto = Boolean(situacao?.codigo_site_visto);
  const whatsappConectado = Boolean(situacao?.whatsapp_conectado);
  if (codigoSiteVisto && whatsappConectado) return null;

  return {
    campanhas_importadas: campanhasImportadas,
    codigo_site_visto: codigoSiteVisto,
    whatsapp_conectado: whatsappConectado,
  };
}
