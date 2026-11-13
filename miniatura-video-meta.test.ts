import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  avisoLarguraVideoInstagram,
  escolherMiniaturaVideoMeta,
  larguraNativaVideoMeta,
} from "./miniatura-video-meta";

describe("escolherMiniaturaVideoMeta", () => {
  test("usa a preferida quando ela tem o maior tamanho", () => {
    expect(escolherMiniaturaVideoMeta([
      { uri: "https://x/a.jpg", width: 1080, is_preferred: false },
      { uri: "https://x/b.jpg", width: 1080, is_preferred: true },
    ])).toBe("https://x/b.jpg");
  });

  test("troca a preferida pequena pela maior", () => {
    expect(escolherMiniaturaVideoMeta([
      { uri: "https://x/pequena.jpg", width: 160, is_preferred: true },
      { uri: "https://x/grande.jpg", width: 720, is_preferred: false },
    ])).toBe("https://x/grande.jpg");
  });

  test("ignora itens sem uri http e lista vazia", () => {
    expect(escolherMiniaturaVideoMeta([{ uri: "", width: 900 }, { width: 900 }, { uri: "https://x/ok.jpg" }])).toBe("https://x/ok.jpg");
    expect(escolherMiniaturaVideoMeta([])).toBeNull();
    expect(escolherMiniaturaVideoMeta(undefined)).toBeNull();
  });
});

describe("larguraNativaVideoMeta", () => {
  test("lê o formato native (caso real: vídeo do WhatsApp, 480x854)", () => {
    expect(larguraNativaVideoMeta({
      format: [{ filter: "130x130", width: 130, height: 232 }, { filter: "native", width: 480, height: 854 }],
    })).toBe(480);
  });

  test("sem native, usa a maior largura conhecida", () => {
    expect(larguraNativaVideoMeta({ format: [{ filter: "720", width: 720 }] })).toBe(720);
    expect(larguraNativaVideoMeta({ thumbnails: { data: [{ width: 1080 }, { width: 540 }] } })).toBe(1080);
    expect(larguraNativaVideoMeta({})).toBeNull();
  });
});

describe("avisoLarguraVideoInstagram", () => {
  test("avisa abaixo de 500 px e fica quieto a partir de 500", () => {
    expect(avisoLarguraVideoInstagram(480)).toContain("480 px");
    expect(avisoLarguraVideoInstagram(480)).toContain("Documento");
    expect(avisoLarguraVideoInstagram(500)).toBeNull();
    expect(avisoLarguraVideoInstagram(1080)).toBeNull();
    expect(avisoLarguraVideoInstagram(null)).toBeNull();
  });
});

describe("index.ts: vídeo na edição de campanha publicada", () => {
  const fonte = readFileSync(new URL("./index.ts", import.meta.url), "utf8").split("\r\n").join("\n");
  const inicioRota = fonte.indexOf('app.post("/meta/editar-campanha"');
  const rota = fonte.slice(inicioRota, fonte.indexOf("\napp.", inicioRota + 10));
  const espera = fonte.slice(
    fonte.indexOf("async function aguardarVideoMetaReady("),
    fonte.indexOf('app.post("/meta/anuncio"'),
  );

  test("miniatura vem das thumbnails em tamanho original, com o picture de reserva", () => {
    expect(espera).toContain("buscarMiniaturaOriginalVideoMeta(token, videoId)");
    expect(espera).toContain("original.miniatura || res.picture || null");
  });

  test("todo criativo com vídeo busca miniatura; vídeo novo espera o processamento", () => {
    expect(rota).not.toContain("if (videoId && imageHashes.length > 0)");
    expect(rota).toContain("await aguardarVideoMetaReady(token, videoId, 15, 5000)");
    expect(rota).toContain("if (videoTrocadoNaEdicao && !videoMeta.ready)");
  });

  test("falha com vídeo novo volta o registro ao vídeo que está no ar", () => {
    const bloco = rota.slice(rota.indexOf("if (videoTrocadoNaEdicao && criativoAtualizadoComErro)"));
    expect(bloco).toContain('avancadas[chave] = configuracoesBanco[chave] ?? null;');
    expect(bloco.indexOf('"video_id"')).toBeGreaterThan(-1);
  });

  test("aviso de largura do Instagram chega na resposta", () => {
    expect(rota).toContain("avisoLarguraVideo = avisoLarguraVideoInstagram(videoMeta.largura)");
    expect(rota).toContain('aviso: avisosEdicao.length ? avisosEdicao.join("\\n\\n") : null');
  });
});
