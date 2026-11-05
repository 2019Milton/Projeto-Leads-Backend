import { expect, test } from "bun:test";
import {
  dadosContaTikTokAposReconexao,
  dataTikTokParaBrasil,
  extrairLeadCsvTikTok,
  fonteEventoTikTok,
  idFonteEventosTikTokNaLista,
  inicioAgendaTikTok,
  interpretarDataHoraBrasil,
  leadIdentificavelTikTok,
  montarEventoLeadSiteTikTok,
  montarEventoTikTok,
} from "./tiktok-utils";

// Exemplos de hash da própria documentação do TikTok (Report App, Web,
// Offline, or CRM Events, v1.3).
const HASH_TELEFONE_DOC = "9f7ec22d72092cd3c0b58726ed9c2d91b92e51a3f29837508fb2948bb22dd2fd"; // "+12133734253"
const HASH_EMAIL_DOC = "848a771458438fc2ec420560d769fb9b9b86851ee338ec56517baabd79d3bb4f"; // " ALICE_abc@gmail.com "

test("formulário instantâneo vai pelo canal CRM; WhatsApp e site vão pelo pixel", () => {
  expect(fonteEventoTikTok({ plataforma: "tiktok", lead_id: "7000" })).toBe("crm");
  expect(fonteEventoTikTok({ plataforma: "whatsapp", origem: "tiktok", lead_id: null })).toBe("web");
  expect(fonteEventoTikTok({ plataforma: "site", origem: "tiktok", lead_id: "x" })).toBe("web");
  expect(fonteEventoTikTok({ plataforma: "tiktok", lead_id: "" })).toBe("web");
});

test("lead identificável: lead_id do formulário basta; nos demais precisa de e-mail ou telefone", () => {
  expect(leadIdentificavelTikTok({ plataforma: "tiktok", lead_id: "7000" })).toBe(true);
  expect(leadIdentificavelTikTok({ plataforma: "whatsapp", telefone: "5521999999999" })).toBe(true);
  expect(leadIdentificavelTikTok({ plataforma: "whatsapp" })).toBe(false);
});

test("evento CRM leva lead_id, origem do CRM, event_id e usuário com os campos certos", () => {
  const item = montarEventoTikTok({
    lead: { id: 42, lead_id: "7000", plataforma: "tiktok", email: " ALICE_abc@gmail.com " },
    evento: "QualifiedLead",
    fonte: "crm",
    telefoneE164: "+12133734253",
    agoraSegundos: 1700000000,
  });
  expect(item).toEqual({
    event: "QualifiedLead",
    event_time: 1700000000,
    event_id: "42-QualifiedLead",
    user: { email: HASH_EMAIL_DOC, phone: HASH_TELEFONE_DOC },
    lead: { lead_id: "7000", lead_event_source: "Plataforma de Leads" },
  });
  expect((item as any).user.phone_number).toBeUndefined();
});

test("evento web casa por telefone E.164 com +; telefone sem + não é enviado", () => {
  const item = montarEventoTikTok({
    lead: { id: 5, plataforma: "whatsapp" },
    evento: "ClosedWon",
    fonte: "web",
    telefoneE164: "+12133734253",
    valorVenda: 1500,
    agoraSegundos: 1,
  });
  expect(item).toEqual({
    event: "ClosedWon",
    event_time: 1,
    event_id: "5-ClosedWon",
    user: { phone: HASH_TELEFONE_DOC },
    properties: { value: 1500, currency: "BRL" },
  });
  expect(item?.lead).toBeUndefined();

  expect(montarEventoTikTok({ lead: { id: 5 }, evento: "ClosedWon", fonte: "web", telefoneE164: "12133734253" })).toBeNull();
});

test("sem identificador para o canal escolhido não monta evento", () => {
  expect(montarEventoTikTok({ lead: { id: 1 }, evento: "QualifiedLead", fonte: "web" })).toBeNull();
  expect(montarEventoTikTok({ lead: { id: 1, email: "a@b.com" }, evento: "QualifiedLead", fonte: "crm" })).toBeNull();
});

test("fonte de eventos: acha pelo nome exato na lista de pixels e de CRM", () => {
  const pixels = { data: { pixels: [
    { pixel_code: "C1", pixel_name: "Plataforma de Leads - antigo" },
    { pixel_code: "C2", pixel_name: "plataforma de leads" },
  ] } };
  expect(idFonteEventosTikTokNaLista(pixels, "pixel")).toBe("C2");
  expect(idFonteEventosTikTokNaLista({ data: { pixels: [{ pixel_code: "C1", pixel_name: "Outro" }] } }, "pixel")).toBeNull();
  expect(idFonteEventosTikTokNaLista({ data: { crm_event_sets: [{ event_set_id: "E9", name: "Plataforma de Leads" }] } }, "crm")).toBe("E9");
  expect(idFonteEventosTikTokNaLista(null, "crm")).toBeNull();
});

test("reconexão mantém a conta escolhida quando ela continua autorizada", () => {
  const anterior = {
    advertiser_ids: ["1", "2"],
    advertiser_id: "2",
    identity_id: "I",
    identity_type: "CUSTOMIZED_USER",
    pixel_code: "P",
    pixel_advertiser_id: "2",
    crm_event_set_id: "E",
    crm_advertiser_id: "2",
    lixo: "x",
  };
  expect(dadosContaTikTokAposReconexao(anterior, ["2", "3"])).toEqual({
    advertiser_ids: ["2", "3"],
    advertiser_id: "2",
    identity_id: "I",
    identity_type: "CUSTOMIZED_USER",
    pixel_code: "P",
    pixel_advertiser_id: "2",
    crm_event_set_id: "E",
    crm_advertiser_id: "2",
  });
  expect(dadosContaTikTokAposReconexao(anterior, ["3"])).toEqual({ advertiser_ids: ["3"] });
  expect(dadosContaTikTokAposReconexao(null, [7])).toEqual({ advertiser_ids: ["7"] });
});

test("calendário em horário de Brasília vira UTC", () => {
  expect(interpretarDataHoraBrasil("2026-11-10T09:00")?.toISOString()).toBe("2026-11-10T12:00:00.000Z");
  expect(interpretarDataHoraBrasil("2026-11-10T22:30:15")?.toISOString()).toBe("2026-11-11T01:30:15.000Z");
  expect(interpretarDataHoraBrasil("2026-11-10T09:00:00Z")?.toISOString()).toBe("2026-11-10T09:00:00.000Z");
  expect(interpretarDataHoraBrasil("lixo")).toBeNull();
  expect(interpretarDataHoraBrasil("")).toBeNull();
});

test("início da agenda: data futura é mantida; vazia ou vencida começa em 1 minuto", () => {
  const agora = Date.parse("2026-11-10T12:00:00Z");
  expect(inicioAgendaTikTok("2026-11-10T10:00", agora).toISOString()).toBe("2026-11-10T13:00:00.000Z");
  expect(inicioAgendaTikTok("2026-11-10T08:00", agora).toISOString()).toBe("2026-11-10T12:01:00.000Z");
  expect(inicioAgendaTikTok("", agora).toISOString()).toBe("2026-11-10T12:01:00.000Z");
  expect(inicioAgendaTikTok("lixo", agora).toISOString()).toBe("2026-11-10T12:01:00.000Z");
});

test("agenda do TikTok (UTC) aparece em horário de Brasília na edição", () => {
  expect(dataTikTokParaBrasil("2026-11-10 12:00:00")).toBe("2026-11-10T09:00");
  expect(dataTikTokParaBrasil("2026-11-10 01:30:00")).toBe("2026-11-09T22:30");
  expect(dataTikTokParaBrasil("")).toBe("");
  expect(dataTikTokParaBrasil("sem data")).toBe("sem data");
});

test("linha do CSV: data ilegível não lança erro e colunas fixas não viram respostas", () => {
  const linha = {
    "Lead ID": "7000",
    "Created time": "data estranha",
    "Campaign ID": "123",
    "Name": "Ana",
    "Phone number": "+5521999999999",
    "Email": "ana@x.com",
    "Qual o seu plano?": "Individual",
  };
  const dados = extrairLeadCsvTikTok(linha);
  expect(dados.leadId).toBe("7000");
  expect(dados.campaignId).toBe("123");
  expect(dados.nome).toBe("Ana");
  expect(dados.telefone).toBe("+5521999999999");
  expect(dados.email).toBe("ana@x.com");
  expect(dados.criadoEm).toBeNull();
  expect(dados.respostas).toEqual([{ pergunta: "Qual o seu plano?", resposta: "Individual" }]);

  expect(extrairLeadCsvTikTok({ lead_id: "1", create_time: "2026-11-01T10:00:00Z" }).criadoEm)
    .toBe("2026-11-01T10:00:00.000Z");
  expect(extrairLeadCsvTikTok({ lead_id: "1" }).nome).toBe("Lead TikTok");
});

test("evento Lead do site: ttclid, hashes, IP/navegador e page.url (exigido em evento web)", () => {
  const evento = montarEventoLeadSiteTikTok({
    lead: {
      id: 42,
      email: " ALICE_abc@gmail.com ",
      atribuicao: {
        ttclid: "E.C.P.abc",
        pagina: "https://corretor.com.br/imovel?ttclid=E.C.P.abc",
        referrer: "https://www.tiktok.com/",
        ip: "203.0.113.1",
        user_agent: "Mozilla/5.0"
      }
    },
    telefoneE164: "+12133734253",
    agoraSegundos: 1700000000
  });
  expect(evento).toEqual({
    event: "Lead",
    event_time: 1700000000,
    event_id: "42-Lead",
    user: {
      ttclid: "E.C.P.abc",
      email: HASH_EMAIL_DOC,
      phone: HASH_TELEFONE_DOC,
      ip: "203.0.113.1",
      user_agent: "Mozilla/5.0"
    },
    page: { url: "https://corretor.com.br/imovel?ttclid=E.C.P.abc", referrer: "https://www.tiktok.com/" }
  });
});

test("evento Lead do site: atribuição em texto, sem página ou sem dado de casamento", () => {
  const comTexto = montarEventoLeadSiteTikTok({
    lead: { id: 1, atribuicao: JSON.stringify({ ttclid: "X", pagina: "https://a.com/", referrer: "" }) }
  });
  expect(comTexto?.user).toEqual({ ttclid: "X" });
  expect(comTexto?.page).toEqual({ url: "https://a.com/" });
  expect(montarEventoLeadSiteTikTok({ lead: { id: 1, atribuicao: { ttclid: "X" } } })).toBeNull();
  expect(montarEventoLeadSiteTikTok({ lead: { id: 1, atribuicao: { pagina: "https://a.com/", ip: "1.1.1.1" } } })).toBeNull();
  expect(montarEventoLeadSiteTikTok({ lead: { id: 1, atribuicao: "{quebrado" } })).toBeNull();
});
