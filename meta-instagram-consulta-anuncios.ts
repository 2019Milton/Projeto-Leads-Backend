import { classificarAutorizacao, type EstadoAutorizacao } from "./meta-instagram-autorizacao-anuncios";

type MetaHttp = (url: string, init?: RequestInit) => Promise<Response>;
export type ResultadoConsultaInstagramAds = {
  estado: EstadoAutorizacao;
  motivo: "CONTA_NAO_SELECIONADA" | "PERFIL_NAO_IDENTIFICADO" | "FALHA_META" | "IDENTIDADE_NA_CONTA" | "SEM_EVIDENCIA_SUFFICIENTE";
};

/** Apenas leitura. O resultado confirma identidade na conta, não garante aprovação de anúncios. */
export async function consultarIdentidadeInstagramAds(input: {
  contaAnunciosId: string | null;
  instagramId: string | null;
  token: string;
  fetchFn?: MetaHttp;
}): Promise<ResultadoConsultaInstagramAds> {
  const idValido = (v: string | null) => typeof v === "string" && /^[0-9]+$/.test(v);
  if (!idValido(input.contaAnunciosId)) return { estado: "indeterminado", motivo: "CONTA_NAO_SELECIONADA" };
  if (!idValido(input.instagramId)) return { estado: "indeterminado", motivo: "PERFIL_NAO_IDENTIFICADO" };
  const fetchFn = input.fetchFn || fetch;
  try {
    const url = new URL("https://graph.facebook.com/v19.0/act_" + input.contaAnunciosId + "/connected_instagram_accounts");
    url.searchParams.set("fields", "id");
    url.searchParams.set("limit", "100");
    const encontrados = new Set<string>();
    let proximo: string | null = url.toString();
    for (let i = 0; proximo && i < 10; i++) {
      const resposta = await fetchFn(proximo, { headers: { Authorization: "Bearer " + input.token } });
      const dados = await resposta.json() as { data?: Array<{ id?: string }>; paging?: { next?: string }; error?: unknown };
      if (!resposta.ok || dados.error || !Array.isArray(dados.data)) {
        return { estado: "indeterminado", motivo: "FALHA_META" };
      }
      for (const item of dados.data) if (typeof item.id === "string") encontrados.add(item.id);
      const pagina = dados.paging?.next;
      if (pagina && (!pagina.startsWith("https://graph.facebook.com/") || pagina.length > 4096)) {
        return { estado: "indeterminado", motivo: "FALHA_META" };
      }
      proximo = pagina || null;
    }
    if (proximo) return { estado: "indeterminado", motivo: "FALHA_META" };
    const estado = classificarAutorizacao({
      instagramId: input.instagramId, contaAnunciosId: input.contaAnunciosId,
      consultaOk: true, identidadesDisponiveis: [...encontrados],
      autorizacaoConfirmada: encontrados.has(input.instagramId!),
    });
    return { estado, motivo: estado === "autorizado" ? "IDENTIDADE_NA_CONTA" : "SEM_EVIDENCIA_SUFFICIENTE" };
  } catch {
    return { estado: "indeterminado", motivo: "FALHA_META" };
  }
}
