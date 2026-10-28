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
    const encontrados = new Set<string>();
    // Ambos os edges precisam completar com sucesso para interpretar a ausência.
    // Qualquer erro deixa o estado indeterminado.
    for (const edge of ["instagram_accounts", "connected_instagram_accounts"]) {
      const url = new URL("https://graph.facebook.com/v19.0/act_" + input.contaAnunciosId + "/" + edge);
      url.searchParams.set("fields", "id");
      url.searchParams.set("limit", "100");
      let proximo: string | null = url.toString();
      const vistos = new Set<string>();
      for (let i = 0; proximo && i < 10; i++) {
        if (vistos.has(proximo)) return { estado: "indeterminado", motivo: "FALHA_META" };
        vistos.add(proximo);
        const resposta = await fetchFn(proximo, { headers: { Authorization: "Bearer " + input.token } });
        const dados = await resposta.json() as { data?: Array<{ id?: string | number }>; paging?: { next?: string }; error?: unknown };
        if (!resposta.ok || dados.error || !Array.isArray(dados.data)) {
          return { estado: "indeterminado", motivo: "FALHA_META" };
        }
        for (const item of dados.data) if (/^[0-9]+$/.test(String(item?.id ?? ""))) encontrados.add(String(item.id));
        const pagina = dados.paging?.next;
        if (pagina) {
          let segura = false;
          try {
            const proximaUrl = new URL(pagina);
            segura = proximaUrl.protocol === "https:" && proximaUrl.hostname === "graph.facebook.com" && proximaUrl.port === "";
          } catch {}
          if (!segura || pagina.length > 4096) return { estado: "indeterminado", motivo: "FALHA_META" };
        }
        proximo = pagina || null;
      }
      if (proximo) return { estado: "indeterminado", motivo: "FALHA_META" };
    }
    if (encontrados.has(input.instagramId!)) {
      return { estado: "autorizado", motivo: "IDENTIDADE_NA_CONTA" };
    }
    // Dois inventários completos e sem o perfil selecionado: a identidade não
    // está disponibilizada para esta conta de anúncios (não é reprovação de anúncio).
    return { estado: "pendente", motivo: "SEM_EVIDENCIA_SUFFICIENTE" };
  } catch {
    return { estado: "indeterminado", motivo: "FALHA_META" };
  }
}
