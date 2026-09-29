import { expect, test } from "bun:test";
import { montarEventoMeta, valorNegocioLead, valorVendaInformado } from "./eventos-meta";

test("valor da venda pras outras plataformas: só no fechamento e só se positivo", () => {
  expect(valorVendaInformado({ valor_negocio: "2500.50" }, "Closed Won")).toBe(2500.5);
  expect(valorVendaInformado({ valor_negocio: "2500.50" }, "Qualified Lead")).toBeNull();
  expect(valorVendaInformado({ valor_negocio: 0 }, "Closed Won")).toBeNull();
  expect(valorVendaInformado({}, "Closed Won")).toBeNull();
});

const agoraSegundos = 1_790_000_000;

test("formulário: lead_id em user_data e custom_data de CRM obrigatório", () => {
  expect(montarEventoMeta({ lead: { lead_id: "1234567890123456" }, etapa: "Qualified Lead", agoraSegundos })).toEqual({
    event_name: "Qualified Lead",
    event_time: agoraSegundos,
    action_source: "system_generated",
    user_data: { lead_id: "1234567890123456" },
    custom_data: { event_source: "crm", lead_event_source: "Plataforma de Leads" }
  });
});

test("formulário: fechamento leva valor só quando informado", () => {
  const comValor = montarEventoMeta({ lead: { lead_id: "9", valor_negocio: "2500.50" }, etapa: "Closed Won", agoraSegundos });
  expect(comValor.event_name).toBe("Closed Won");
  expect(comValor.custom_data).toEqual({ event_source: "crm", lead_event_source: "Plataforma de Leads", currency: "BRL", value: 2500.5 });

  const semValor = montarEventoMeta({ lead: { lead_id: "9" }, etapa: "Closed Won", agoraSegundos });
  expect(semValor.custom_data).toEqual({ event_source: "crm", lead_event_source: "Plataforma de Leads" });
});

test("WhatsApp: só nomes da lista padrão da Meta", () => {
  const lead = { ctwa_clid: "ARAkLkA8", lead_id: null };
  const qualificado = montarEventoMeta({ lead, etapa: "Qualified Lead", wabaId: "123", agoraSegundos });
  expect(qualificado).toEqual({
    event_name: "QualifiedLead",
    event_time: agoraSegundos,
    action_source: "business_messaging",
    messaging_channel: "whatsapp",
    user_data: { ctwa_clid: "ARAkLkA8", whatsapp_business_account_id: "123" }
  });
});

test("WhatsApp: fechamento vira Purchase com moeda e valor (0 quando não informado)", () => {
  const comValor = montarEventoMeta({ lead: { ctwa_clid: "x", valor_negocio: 1890 }, etapa: "Closed Won", wabaId: "1", agoraSegundos });
  expect(comValor.event_name).toBe("Purchase");
  expect(comValor.custom_data).toEqual({ currency: "BRL", value: 1890 });

  const semValor = montarEventoMeta({ lead: { ctwa_clid: "x" }, etapa: "Closed Won", wabaId: "1", agoraSegundos });
  expect(semValor.custom_data).toEqual({ currency: "BRL", value: 0 });
});

test("valor do negócio: aceita número/numeric do banco, rejeita lixo e negativo", () => {
  expect(valorNegocioLead({ valor_negocio: "1500.00" })).toBe(1500);
  expect(valorNegocioLead({ valor_negocio: 99.999 })).toBe(100);
  expect(valorNegocioLead({ valor_negocio: 0 })).toBe(0);
  expect(valorNegocioLead({ valor_negocio: null })).toBeNull();
  expect(valorNegocioLead({ valor_negocio: "" })).toBeNull();
  expect(valorNegocioLead({ valor_negocio: "abc" })).toBeNull();
  expect(valorNegocioLead({ valor_negocio: -5 })).toBeNull();
  expect(valorNegocioLead({})).toBeNull();
});
