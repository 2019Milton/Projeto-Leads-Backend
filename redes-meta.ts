// Evidência para o painel. Nunca usada para alterar targeting/publicar anúncios.
export const REDES_META_PAINEL = ["facebook", "instagram"] as const;
type Rede = typeof REDES_META_PAINEL[number];
type Registro = Record<string, any>;

export function normalizarRedesMeta(valor: unknown): Rede[] {
  const redes = Array.isArray(valor)
    ? valor.map(item => String(item).trim().toLowerCase()) : [];
  return REDES_META_PAINEL.filter(rede => redes.includes(rede));
}

function objeto(valor: unknown): Registro {
  if (typeof valor === "string") {
    try { return objeto(JSON.parse(valor)); } catch { return {}; }
  }
  return valor && typeof valor === "object" && !Array.isArray(valor) ? valor : {};
}

export function redesCampanhaPainelMeta(campanha: Registro): Rede[] {
  const cfg = objeto(campanha.configuracoes_avancadas);
  const evidencia = objeto(cfg.redes_identificadas_meta);
  // Duplicar uma campanha pode copiar o JSON: não reaproveitar evidência de outra.
  if (campanha.campaign_id && evidencia.campaign_id === String(campanha.campaign_id)) {
    const configuradas = normalizarRedesMeta(evidencia.configuradas);
    if (evidencia.configuracao_completa === true) return configuradas;
    const identificadas = normalizarRedesMeta([
      ...configuradas, ...normalizarRedesMeta(evidencia.com_entrega)
    ]);
    if (identificadas.length) return identificadas;
  }
  return normalizarRedesMeta(cfg.plataformas);
}

export function contarCampanhasPorRedeMeta(campanhas: Registro[]) {
  const por_rede = {
    facebook: { campanhas: 0, campanhas_ativas: 0 },
    instagram: { campanhas: 0, campanhas_ativas: 0 }
  };
  let sem_rede_identificada = 0;
  for (const campanha of campanhas) {
    const redes = redesCampanhaPainelMeta(campanha);
    if (!redes.length) sem_rede_identificada++;
    for (const rede of redes) {
      por_rede[rede].campanhas++;
      if (["ACTIVE", "ENABLED"].includes(String(campanha.status).toUpperCase())) {
        por_rede[rede].campanhas_ativas++;
      }
    }
  }
  return { por_rede, sem_rede_identificada };
}

export function montarEvidenciasRedesMeta(
  campanhas: string[], conjuntos: Registro[], insights: Registro[],
  consultadoEm = new Date().toISOString()
): Map<string, Registro> {
  const resultado = new Map<string, Registro>();
  for (const id of campanhas) {
    const itens = conjuntos.filter(item => String(item.campaign_id) === id &&
      !["DELETED", "ARCHIVED"].includes(String(item.effective_status).toUpperCase()));
    const plataformas = itens.map(item => {
      const targeting = objeto(item.targeting);
      return Array.isArray(targeting.publisher_platforms) && targeting.publisher_platforms.length
        ? targeting.publisher_platforms : targeting.effective_publisher_platforms;
    });
    const entrega = insights.filter(item => String(item.campaign_id) === id && Number(item.impressions) > 0);
    const datas = entrega.flatMap(item => [item.date_start, item.date_stop]).filter(Boolean).sort();
    resultado.set(id, {
      campaign_id: id,
      configuradas: normalizarRedesMeta(plataformas.flatMap(item => Array.isArray(item) ? item : [])),
      configuracao_completa: itens.length > 0 && plataformas.every(item => Array.isArray(item) && item.length > 0),
      com_entrega: normalizarRedesMeta(entrega.map(item => item.publisher_platform)),
      periodo_entrega: datas.length ? { inicio: datas[0], fim: datas[datas.length - 1] } : null,
      consultado_em: consultadoEm
    });
  }
  return resultado;
}

export async function consultarRedesMeta(
  token: string, contaId: string, campanhas: string[], requisitar: typeof fetch = fetch
) {
  async function listar(recurso: string, parametros: Record<string, string>) {
    let url: URL | null = new URL(`https://graph.facebook.com/v19.0/${contaId}/${recurso}`);
    Object.entries({ ...parametros, limit: "100" }).forEach(([chave, valor]) => url!.searchParams.set(chave, valor));
    const linhas: Registro[] = [];
    const visitadas = new Set<string>();
    while (url) {
      if (url.origin !== "https://graph.facebook.com" || visitadas.has(url.href) || visitadas.size >= 100) {
        throw new Error("Paginação de redes Meta incompleta");
      }
      visitadas.add(url.href);
      const resposta = await requisitar(url, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000)
      });
      const dados = await resposta.json() as Registro;
      if (!resposta.ok || dados.error || !Array.isArray(dados.data)) {
        // Não expor token, URL paginada ou resposta bruta da Meta nos logs.
        throw new Error(`Falha ao consultar redes Meta (HTTP ${resposta.status})`);
      }
      linhas.push(...dados.data);
      url = dados.paging?.next ? new URL(dados.paging.next) : null;
    }
    return linhas;
  }
  if (!campanhas.length) return new Map<string, Registro>();
  const conjuntos = await listar("adsets", { fields: "campaign_id,effective_status,targeting" });
  const parametros = { fields: "campaign_id,impressions", level: "campaign", breakdowns: "publisher_platform" };
  // last_30d termina ontem; hoje precisa de consulta própria.
  const historico = await listar("insights", { ...parametros, date_preset: "last_30d" });
  const hoje = await listar("insights", { ...parametros, date_preset: "today" });
  return montarEvidenciasRedesMeta(campanhas, conjuntos, [...historico, ...hoje]);
}

// Merge atômico apenas dos metadados; preserva nicho, criativos e posicionamentos.
export const SQL_SALVAR_REDES_META = `
  UPDATE campanhas
  SET configuracoes_avancadas =
    (CASE WHEN jsonb_typeof(configuracoes_avancadas) = 'object'
      THEN configuracoes_avancadas ELSE '{}'::jsonb END)
    || jsonb_build_object('redes_identificadas_meta', $4::jsonb)
  WHERE usuario_id = $1 AND conta_anuncios_id = $2 AND campaign_id = $3
    AND LOWER(COALESCE(plataforma, 'meta')) IN ('meta', 'facebook', 'instagram')
`;
