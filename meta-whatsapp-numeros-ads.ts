/**
 * A Meta pode enviar uma conversa para um WhatsApp conectado mesmo quando o bot
 * automático está pausado. Não habilitar/alterar o bot implicitamente.
 */
export function validarWhatsappAdsMeta(
  entrada: {numero?: unknown; status?: unknown; bot_ativo?: unknown} | null | undefined,
  normalizar: (numero: unknown) => string
) {
  if (!entrada || String(entrada.status || "").toLowerCase() !== "conectado") {
    throw new Error("O WhatsApp selecionado precisa estar conectado à Plataforma de Leads.");
  }
  const numero = normalizar(entrada.numero);
  if (!/^55\d{10,11}$/.test(numero)) {
    throw new Error("Número de WhatsApp inválido.");
  }
  return {
    numero,
    bot_ativo: entrada.bot_ativo === true,
    aviso_bot: entrada.bot_ativo !== true
      ? "O WhatsApp está conectado, porém o bot está pausado. Mensagens poderão chegar ao número sem atendimento automático."
      : null
  };
}
