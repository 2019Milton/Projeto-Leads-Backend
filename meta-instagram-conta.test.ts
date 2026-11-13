import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  escolhaInstagramSalva,
  escolherInstagramParaConta,
  montarCandidatosInstagramConta,
  ordenarPaginasPelaConta,
} from "./meta-instagram-conta";

describe("montarCandidatosInstagramConta", () => {
  test("caso real TVC Travel: nada liberado e a Página da conta sem Instagram → nenhum candidato", () => {
    expect(montarCandidatosInstagramConta({
      autorizados: [],
      paginasDaConta: [{ id: "1347341721803168", name: "Club TVC ", instagram_business_account: null }],
    })).toEqual([]);
  });

  test("junta liberados e vinculados às Páginas, sem duplicar, liberados primeiro", () => {
    const candidatos = montarCandidatosInstagramConta({
      autorizados: [{ id: "200", username: "liberado" }, { id: "x" }],
      paginasDaConta: [
        { id: "10", name: "Página A", instagram_business_account: { id: "100", username: "da_pagina" } },
        { id: "11", name: "Página B", instagram_business_account: { id: "200", username: "liberado" } },
        { id: "12", name: "Página C", instagram_business_account: { id: "100" } },
      ],
    });
    expect(candidatos.map((c) => [c.id, c.liberado_na_conta, c.paginas.map((p) => p.name)])).toEqual([
      ["200", true, ["Página B"]],
      ["100", false, ["Página A", "Página C"]],
    ]);
  });
});

describe("escolherInstagramParaConta", () => {
  const a = { id: "1", username: "a", profile_picture_url: null, liberado_na_conta: true, paginas: [] };
  const b = { id: "2", username: "b", profile_picture_url: null, liberado_na_conta: true, paginas: [] };
  const c = { id: "3", username: "c", profile_picture_url: null, liberado_na_conta: false, paginas: [{ id: "9", name: "P" }] };

  test("escolha salva vale se ainda for candidata", () => {
    expect(escolherInstagramParaConta([a, b], "2")).toEqual({ instagram: b, selecao_pendente: false });
    expect(escolherInstagramParaConta([a, b], "99")).toEqual({ instagram: null, selecao_pendente: true });
  });

  test("único candidato, ou único liberado, é escolhido sozinho", () => {
    expect(escolherInstagramParaConta([c], null).instagram).toBe(c);
    expect(escolherInstagramParaConta([a, c], null)).toEqual({ instagram: a, selecao_pendente: false });
  });

  test("dois liberados e nenhuma escolha: não adivinha", () => {
    expect(escolherInstagramParaConta([a, b], null)).toEqual({ instagram: null, selecao_pendente: true });
    expect(escolherInstagramParaConta([], null)).toEqual({ instagram: null, selecao_pendente: false });
  });
});

describe("escolhaInstagramSalva", () => {
  test("só vale para a conta de anúncios em que foi feita (com ou sem act_)", () => {
    const conexao = { instagram_anuncios_id: "555", instagram_anuncios_conta: "1623610255883326" };
    expect(escolhaInstagramSalva(conexao, "act_1623610255883326")).toBe("555");
    expect(escolhaInstagramSalva(conexao, "1623610255883326")).toBe("555");
    expect(escolhaInstagramSalva(conexao, "act_999")).toBeNull();
    expect(escolhaInstagramSalva({}, "act_1")).toBeNull();
  });
});

describe("ordenarPaginasPelaConta", () => {
  test("Páginas da conta primeiro, mantendo a ordem; sem a lista da conta não mexe", () => {
    const paginas = [{ id: "1", name: "Rhamá Saúde" }, { id: "2", name: "Outra" }, { id: "3", name: "Club TVC" }];
    expect(ordenarPaginasPelaConta(paginas, ["3"]).map((p) => [p.name, p.da_conta_anuncios])).toEqual([
      ["Club TVC", true], ["Rhamá Saúde", false], ["Outra", false],
    ]);
    expect(ordenarPaginasPelaConta(paginas, null)).toBe(paginas);
  });
});

describe("index.ts: Instagram vem da conta de anúncios escolhida", () => {
  const fonte = readFileSync(new URL("./index.ts", import.meta.url), "utf8").split("\r\n").join("\n");
  const trecho = (inicio: string) => {
    const i = fonte.indexOf(inicio);
    return fonte.slice(i, fonte.indexOf("\napp.", i + 10));
  };

  test("status, autorização e vínculo automático não usam o primeiro Instagram de todas as Páginas", () => {
    const status = trecho('"/meta/status-completo"');
    const depoisDaConta = status.slice(status.indexOf("const adAccountId = contaAds.id;"));
    expect(depoisDaConta).not.toContain("detectarInstagramMeta(");
    expect(depoisDaConta).toContain("resolverInstagramDaContaAnuncios(");
    expect(depoisDaConta).toContain("instagram_candidatos: instagramConta.candidatos");
    for (const rota of ['app.get("/meta/instagram/autorizacao-anuncios"', 'app.post("/meta/instagram/vincular-business"']) {
      const corpo = trecho(rota);
      expect(corpo).not.toContain("detectarInstagramMeta(");
      expect(corpo).toContain("resolverInstagramDaContaAnuncios(");
    }
  });

  test("rota de escolha só aceita Instagram ligado à conta", () => {
    const rota = trecho('app.post("/meta/instagram/escolher"');
    expect(rota).toContain("candidatos.some((candidato) => candidato.id === instagramId)");
    expect(rota).toContain("UPDATE meta_conexoes SET instagram_anuncios_id = $1, instagram_anuncios_conta = $2 WHERE id = $3");
    expect(fonte).toContain("ADD COLUMN IF NOT EXISTS instagram_anuncios_conta TEXT");
  });
});
