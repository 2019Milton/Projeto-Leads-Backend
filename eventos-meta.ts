// Monta o evento de qualificação/fechamento enviado ao dataset da Meta
// (POST /{dataset_id}/events). São duas integrações diferentes da Meta, com
// regras diferentes — misturar as duas faz o evento ser aceito pela API
// (responde 200) mas não servir pra nada:
//
// 1) Lead Ads / formulário instantâneo — "Conversion Leads" (CRM):
//    event_name é livre (o nome da etapa do funil no CRM), o lead é
//    identificado por user_data.lead_id e custom_data.event_source = "crm" +
//    custom_data.lead_event_source (nome do CRM) são obrigatórios.
//    Doc: developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/payload-specification
//
// 2) Click-to-WhatsApp — "Conversions API for Business Messaging":
//    action_source "business_messaging", messaging_channel "whatsapp",
//    user_data com ctwa_clid + whatsapp_business_account_id, e event_name
//    SÓ da lista padrão (Purchase, LeadSubmitted, QualifiedLead, ...). É o
//    Purchase que a Meta usa pra otimizar anúncio de WhatsApp por venda — por
//    isso o fechamento vai como Purchase, com o valor do negócio.
//    Doc: developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging

export type EtapaConversao = "Qualified Lead" | "Closed Won";

// Demais etapas do funil, só para lead de formulário: no Conversion Leads o
// nome da etapa é livre e a Meta recomenda mandar todas as etapas (ela usa o
// funil inteiro pra aprender quem avança). No WhatsApp não há equivalente —
// lá só valem os nomes da lista padrão (ver EVENTO_WHATSAPP_META).
export type EtapaFunilFormulario = "Contacted" | "In Conversation" | "Lost";

export const ETAPA_FUNIL_POR_STATUS: Record<string, EtapaFunilFormulario> = {
  primeiro_contato: "Contacted",
  em_conversa: "In Conversation",
  perdido: "Lost"
};

// Etapa do funil que o status atual do lead representa, se for lead de
// formulário da Meta (lead_id nativo, sem ctwa_clid).
export function etapaFunilFormularioMeta(lead: any): EtapaFunilFormulario | null {
  if (!lead?.lead_id || lead?.ctwa_clid) return null;
  return ETAPA_FUNIL_POR_STATUS[String(lead?.status || "")] ?? null;
}

// Nome do "CRM" que aparece no Gerenciador de Eventos da Meta (mesmo nome do
// dataset criado em obterOuCriarDatasetMetaUsuario).
export const NOME_CRM_META = "Plataforma de Leads";

// O corretor informa o valor em reais na tela ao marcar o lead como fechado.
export const MOEDA_VALOR_NEGOCIO = "BRL";

export const EVENTO_WHATSAPP_META: Record<EtapaConversao, string> = {
  "Qualified Lead": "QualifiedLead",
  "Closed Won": "Purchase"
};

// valor_negocio vem do banco como NUMERIC (string no driver pg). Inválido,
// negativo ou vazio vira null.
export function valorNegocioLead(lead: any): number | null {
  const bruto = lead?.valor_negocio;
  if (bruto === null || bruto === undefined || String(bruto).trim() === "") return null;
  const valor = Number(bruto);
  return Number.isFinite(valor) && valor >= 0 ? Math.round(valor * 100) / 100 : null;
}

// Valor da venda a mandar pras outras plataformas (Google, TikTok, LinkedIn):
// só no fechamento e só quando o corretor informou um valor positivo — sem
// valor, o evento vai exatamente como antes (sem campo de valor, ou 0 onde o
// campo já existia).
export function valorVendaInformado(lead: any, etapa: EtapaConversao): number | null {
  if (etapa !== "Closed Won") return null;
  const valor = valorNegocioLead(lead);
  return valor !== null && valor > 0 ? valor : null;
}

export function montarEventoMeta(params: {
  lead: any;
  etapa: EtapaConversao | EtapaFunilFormulario;
  wabaId?: string | null;
  agoraSegundos?: number;
}): Record<string, any> {
  const { lead, etapa } = params;
  const eventTime = params.agoraSegundos ?? Math.floor(Date.now() / 1000);
  const valor = valorNegocioLead(lead);

  if (lead?.ctwa_clid) {
    const nomeWhatsapp = EVENTO_WHATSAPP_META[etapa as EtapaConversao];
    if (!nomeWhatsapp) {
      throw new Error(`Etapa "${etapa}" não tem evento equivalente no WhatsApp`);
    }
    const evento: Record<string, any> = {
      event_name: nomeWhatsapp,
      event_time: eventTime,
      action_source: "business_messaging",
      messaging_channel: "whatsapp",
      user_data: {
        // ctwa_clid vai cru (não hasheado), diferente dos campos de PII.
        ctwa_clid: lead.ctwa_clid,
        whatsapp_business_account_id: params.wabaId
      }
    };

    // Purchase sempre leva moeda e valor; sem valor informado vai 0 (decisão
    // do produto: não segurar o sinal de venda por falta do valor).
    if (etapa === "Closed Won") {
      evento.custom_data = { currency: MOEDA_VALOR_NEGOCIO, value: valor ?? 0 };
    }

    return evento;
  }

  const customData: Record<string, any> = {
    event_source: "crm",
    lead_event_source: NOME_CRM_META
  };

  if (etapa === "Closed Won" && valor !== null && valor > 0) {
    customData.currency = MOEDA_VALOR_NEGOCIO;
    customData.value = valor;
  }

  return {
    event_name: etapa,
    event_time: eventTime,
    action_source: "system_generated",
    user_data: { lead_id: String(lead.lead_id) },
    custom_data: customData
  };
}
