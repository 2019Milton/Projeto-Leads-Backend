import { describe, expect, test } from "bun:test";
import { diaNoBrasil, diasPeriodoBrasil, extrairLeadsActionsMeta } from "./performance-meta";

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
