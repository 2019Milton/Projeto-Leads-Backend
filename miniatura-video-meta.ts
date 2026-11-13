// Miniatura e largura de um vídeo da Meta (GET /{video-id}?fields=format,thumbnails).
// O campo `picture` do vídeo vem reduzido (até 160 px); como miniatura do
// anúncio, o Instagram recusa a veiculação por "mídia com menos de 500 px".

export const LARGURA_MINIMA_INSTAGRAM = 500;

type MiniaturaMeta = { uri?: unknown; width?: unknown; is_preferred?: unknown };

const largura = (valor: unknown) => {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// A preferida pela Meta, desde que seja do maior tamanho disponível; senão a maior.
export function escolherMiniaturaVideoMeta(miniaturas: unknown): string | null {
  const lista = (Array.isArray(miniaturas) ? miniaturas : []).filter(
    (m: MiniaturaMeta) => typeof m?.uri === "string" && /^https?:\/\//.test(m.uri as string),
  ) as MiniaturaMeta[];
  if (!lista.length) return null;

  const maior = Math.max(...lista.map((m) => largura(m.width)));
  const preferida = lista.find((m) => m.is_preferred === true && largura(m.width) >= maior);
  const escolhida = preferida || lista.find((m) => largura(m.width) === maior) || lista[0];
  return escolhida.uri as string;
}

// Largura do arquivo original (format "native"); sem ele, a maior conhecida.
export function larguraNativaVideoMeta(video: any): number | null {
  const formatos = Array.isArray(video?.format) ? video.format : [];
  const nativo = formatos.find((f: any) => f?.filter === "native");
  const miniaturas = Array.isArray(video?.thumbnails?.data) ? video.thumbnails.data : [];
  const valor =
    largura(nativo?.width) ||
    Math.max(0, ...formatos.map((f: any) => largura(f?.width))) ||
    Math.max(0, ...miniaturas.map((t: any) => largura(t?.width)));
  return valor > 0 ? valor : null;
}

export function avisoLarguraVideoInstagram(larguraVideo: number | null | undefined): string | null {
  if (!larguraVideo || larguraVideo >= LARGURA_MINIMA_INSTAGRAM) return null;
  return (
    `O vídeo tem ${larguraVideo} px de largura e o Instagram só veicula vídeo com pelo menos ` +
    `${LARGURA_MINIMA_INSTAGRAM} px: no Instagram o anúncio vai ficar "com problemas". Envie o arquivo ` +
    `original do vídeo (se vier pelo WhatsApp, peça para mandarem como Documento, que não reduz a qualidade).`
  );
}
