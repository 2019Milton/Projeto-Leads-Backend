import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  avisoCaptacaoImportadas,
  diaNoBrasil,
  diasPeriodoBrasil,
  extrairLeadsActionsMeta,
  painelComGastoSemLead,
} from "./performance-meta";

const acao = (action_type: string, value: string | number) => ({ action_type, value: String(value) });
const CONVERSA = "onsite_conversion.messaging_conversation_started_7d";

describe("extrairLeadsActionsMeta", () => {
  test("WhatsApp com action lead: vale a conversa (resposta real, usuário 23, 04/11/2026)", () => {
    expect(
      extrairLeadsActionsMeta([
        acao("onsite_conversion.lead", 1),
        acao("offsite_complete_registration_add_meta_leads", 1),
        acao("offsite_search_add_meta_leads", 1),
        acao("onsite_web_lead", 1),
        acao("onsite_conversion.total_messaging_connection", 17),
        acao("onsite_conversion.messaging_first_reply", 14),
        acao("lead", 1),
        acao("offsite_content_view_add_meta_leads", 1),
        acao(CONVERSA, 17),
        acao("onsite_conversion.lead_grouped", 1),
      ])
    ).toBe(17);
  });

  test("WhatsApp sem action lead: vale a conversa (usuário 23, 03/11/2026)", () => {
    expect(
      extrairLeadsActionsMeta([
        acao("onsite_conversion.total_messaging_connection", 13),
        acao("onsite_conversion.messaging_first_reply", 12),
        acao(CONVERSA, 12),
      ])
    ).toBe(12);
  });

  test("formulário: não soma os nomes repetidos do mesmo lead", () => {
    expect(
      extrairLeadsActionsMeta([
        acao("onsite_conversion.lead_grouped", 8),
        acao("onsite_conversion.lead", 8),
        acao("lead", 8),
      ])
    ).toBe(8);
  });

  test("campanha com mais lead que conversa continua valendo o lead (usuário 17)", () => {
    expect(
      extrairLeadsActionsMeta([
        acao("onsite_conversion.lead_grouped", 15),
        acao("lead", 15),
        acao(CONVERSA, 9),
      ])
    ).toBe(15);
  });

  test("site: conta o lead do pixel", () => {
    expect(extrairLeadsActionsMeta([acao("offsite_conversion.fb_pixel_lead", 5)])).toBe(5);
  });

  test("sem os nomes conhecidos, soma o que tiver lead no nome", () => {
    expect(
      extrairLeadsActionsMeta([acao("onsite_web_lead", 2), acao("outro_lead", 1), acao("link_click", 40)])
    ).toBe(3);
  });

  test("sem actions ou com valor inválido não quebra", () => {
    expect(extrairLeadsActionsMeta()).toBe(0);
    expect(extrairLeadsActionsMeta([])).toBe(0);
    expect(extrairLeadsActionsMeta([acao("link_click", 40)])).toBe(0);
    expect(extrairLeadsActionsMeta([{ action_type: CONVERSA }])).toBe(0);
  });
});

describe("diasPeriodoBrasil", () => {
  test("às 21h10 de Brasília ainda é o mesmo dia, embora já seja amanhã em UTC", () => {
    const agora = new Date("2026-11-06T00:10:00Z");
    expect(diaNoBrasil(agora)).toBe("2026-11-05");
    expect(diasPeriodoBrasil(7, agora)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
    ]);
  });

  test("à meia-noite de Brasília vira o dia", () => {
    expect(diaNoBrasil(new Date("2026-11-06T02:59:59Z"))).toBe("2026-11-05");
    expect(diaNoBrasil(new Date("2026-11-06T03:00:00Z"))).toBe("2026-11-06");
  });

  test("atravessa a virada do ano e devolve a quantidade pedida", () => {
    const dias = diasPeriodoBrasil(3, new Date("2027-01-01T12:00:00Z"));
    expect(dias).toEqual(["2026-12-30", "2026-12-31", "2027-01-01"]);
    expect(diasPeriodoBrasil(365, new Date("2027-01-01T12:00:00Z"))).toHaveLength(365);
  });
});

describe("fuso do dia nas rotas de performance", () => {
  const codigo = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const rota = (caminhoRota: string) => {
    const inicio = codigo.indexOf(`app.get("${caminhoRota}"`);
    expect(inicio).toBeGreaterThan(-1);
    // Só o corpo da rota e sem comentários: o comentário da Meta cita o agrupamento antigo.
    return codigo.slice(inicio, codigo.indexOf("\n});\n", inicio)).replace(/^\s*\/\/.*$/gm, "");
  };

  test.each(["/meta/performance-diaria", "/google/performance-diaria", "/tiktok/performance-diaria"])(
    "%s fecha o dia e agrupa os leads no calendário do Brasil",
    (caminhoRota) => {
      const bloco = rota(caminhoRota);
      expect(bloco).toContain("diasPeriodoBrasil(dias)");
      expect(bloco).toContain("AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo'");
      expect(bloco).not.toContain("DATE(criado_em)");
    }
  );

  test("o detalhe do dia no Google usa o mesmo calendário do resumo", () => {
    const bloco = rota("/google/performance-diaria/:data/campanhas");
    expect(bloco).toContain("AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = $2::date");
    expect(bloco).not.toContain("DATE(criado_em)");
  });

  test("o LinkedIn continua em UTC, porque a Ad Analytics fecha o dia em UTC", () => {
    const bloco = rota("/linkedin/performance-diaria");
    expect(bloco).toContain("DATE(criado_em)");
    expect(bloco).not.toContain("diasPeriodoBrasil");
  });
});

describe("painelComGastoSemLead", () => {
  test("gasto sem lead salvo", () => {
    expect(painelComGastoSemLead([{ gasto: 75.19, leads_plataforma: 0 }, { gasto: 0, leads_plataforma: 0 }])).toBe(true);
  });

  test("com lead em qualquer dia, não", () => {
    expect(painelComGastoSemLead([{ gasto: 75.19, leads_plataforma: 0 }, { gasto: 10, leads_plataforma: 1 }])).toBe(false);
  });

  test("sem gasto, não", () => {
    expect(painelComGastoSemLead([{ gasto: 0, leads_plataforma: 0 }])).toBe(false);
    expect(painelComGastoSemLead([])).toBe(false);
  });

  test("os leads contados pela Meta não valem como lead salvo", () => {
    expect(painelComGastoSemLead([{ gasto: 100, leads: 32, leads_plataforma: 0 } as any])).toBe(true);
  });
});

describe("avisoCaptacaoImportadas", () => {
  const conta = { campanhas_importadas: 46, campanhas_proprias: 0, codigo_site_visto: false, whatsapp_conectado: false };

  test("só importadas, sem código e sem WhatsApp (usuário 17 no Google, 05/11/2026)", () => {
    expect(avisoCaptacaoImportadas(conta)).toEqual({
      campanhas_importadas: 46,
      codigo_site_visto: false,
      whatsapp_conectado: false,
    });
  });

  test("com alguma campanha criada na plataforma, não afirma a causa", () => {
    expect(avisoCaptacaoImportadas({ ...conta, campanhas_proprias: 1 })).toBeNull();
  });

  test("sem campanha importada, não avisa", () => {
    expect(avisoCaptacaoImportadas({ ...conta, campanhas_importadas: 0 })).toBeNull();
  });

  test("com só um dos caminhos ligado, avisa o que falta", () => {
    expect(avisoCaptacaoImportadas({ ...conta, codigo_site_visto: true })).toEqual({
      campanhas_importadas: 46,
      codigo_site_visto: true,
      whatsapp_conectado: false,
    });
    expect(avisoCaptacaoImportadas({ ...conta, whatsapp_conectado: true })?.whatsapp_conectado).toBe(true);
  });

  test("com código e WhatsApp ligados, a causa é outra", () => {
    expect(avisoCaptacaoImportadas({ ...conta, codigo_site_visto: true, whatsapp_conectado: true })).toBeNull();
  });

  test("sem dados, não avisa", () => {
    expect(avisoCaptacaoImportadas(undefined)).toBeNull();
  });
});

describe("aviso de captação nas rotas de performance", () => {
  const codigo = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

  test.each(["/meta/performance-diaria", "/google/performance-diaria", "/tiktok/performance-diaria", "/linkedin/performance-diaria"])(
    "%s devolve o aviso",
    (caminhoRota) => {
      const inicio = codigo.indexOf(`app.get("${caminhoRota}"`);
      expect(inicio).toBeGreaterThan(-1);
      const bloco = codigo.slice(inicio, codigo.indexOf("\n});\n", inicio));
      expect(bloco).toContain("aviso_captacao: await avisoCaptacaoPainelPerformance(");
    }
  );
});
