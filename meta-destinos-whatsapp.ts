type Req = (url: string, init?: RequestInit) => Promise<Response>;
type Obj = Record<string, any>;
const obj = (x: unknown): Obj => x && typeof x === "object" && !Array.isArray(x) ? x as Obj : {};
const txt = (x: unknown): string | null => typeof x === "string" && x.trim() ? x.trim() : null;

function buscarNumeroCriativo(criativo: Obj): string | null {
  const story = obj(criativo.object_story_spec);
  const partes = [story.link_data, story.video_data, story.template_data].map(obj);
  const extrair = (valor: unknown): string | null => {
    const raw = txt(valor);
    if (!raw) return null;
    const digitos = raw.replace(/\D/g, "");
    if (/^\+?\d[\d\s()+.-]{9,20}$/.test(raw) && digitos.length >= 10 && digitos.length <= 15) return digitos;
    try {
      const u = new URL(raw);
      if (!["wa.me", "api.whatsapp.com", "web.whatsapp.com"].includes(u.hostname.toLowerCase())) return null;
      return u.searchParams.get("phone") || u.pathname.replace(/\D/g, "") || null;
    } catch { return null; }
  };
  for (const part of partes) {
    const cta = obj(obj(part.call_to_action).value);
    for (const valor of [cta.whatsapp_number, cta.phone_number, cta.link, part.link]) {
      const n = extrair(valor);
      if (n) return n;
    }
  }
  return extrair(criativo.object_url) || null;
}

async function coletar(
  campanhaId: string, aresta: "adsets" | "ads", fields: string,
  token: string, requisitar: Req
): Promise<Obj[]> {
  const lista: Obj[] = [];
  const vistos = new Set<string>();
  let url: string | null = "https://graph.facebook.com/v19.0/" +
    encodeURIComponent(campanhaId) + "/" + aresta +
    "?fields=" + encodeURIComponent(fields) + "&limit=100";
  while (url && vistos.size < 3 && lista.length < 300) {
    const pagina = new URL(url);
    if (pagina.protocol !== "https:" || pagina.hostname !== "graph.facebook.com")
      throw new Error("Paginação inválida retornada pela Meta");
    if (vistos.has(url)) break;
    vistos.add(url);
    const res = await requisitar(url, { headers: { Authorization: "Bearer " + token } });
    const data = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(data?.data))
      throw new Error("Consulta de destino Meta indisponível (HTTP " + res.status + ")");
    lista.push(...data.data);
    url = typeof data.paging?.next === "string" ? data.paging.next : null;
  }
  return lista.slice(0, 300);
}

// Diagnóstico exclusivamente GET: não atualiza anúncios, campanhas nem tabelas.
export async function consultarDestinoWhatsappMeta(
  campanhaId: string, token: string, requisitar: Req = fetch
) {
  if (!/^\d+$/.test(campanhaId)) throw new Error("ID da campanha inválido");
  const conjuntos = await coletar(campanhaId, "adsets",
    "id,name,destination_type,promoted_object,effective_status", token, requisitar);
  const anuncios = await coletar(campanhaId, "ads",
    "id,name,adset_id,effective_status,creative{id,object_story_spec,object_url}", token, requisitar);
  const conjuntosPorId = new Map(conjuntos.map(x => [String(x.id), x]));
  return {
    campaign_id: campanhaId,
    somente_leitura: true,
    conjuntos: conjuntos.map(c => ({
      id: String(c.id), nome: txt(c.name), destino: txt(c.destination_type),
      numero_whatsapp: txt(obj(c.promoted_object).whatsapp_phone_number),
      status: txt(c.effective_status)
    })),
    anuncios: anuncios.map(a => {
      const grupo = conjuntosPorId.get(String(a.adset_id)) || {};
      const meta = txt(obj(grupo.promoted_object).whatsapp_phone_number);
      const criativo = buscarNumeroCriativo(obj(a.creative));
      return {
        id: String(a.id), nome: txt(a.name), conjunto_id: txt(a.adset_id),
        destino: txt(grupo.destination_type), status: txt(a.effective_status),
        numero_whatsapp: meta || criativo || null,
        fonte_numero: meta ? "conjunto" : criativo ? "criativo" : null
      };
    }),
    observacao: "Sem número significa que a API não retornou o destino nos campos consultados, não que o anúncio esteja sem WhatsApp."
  };
}
