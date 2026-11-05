// Data de envio de um lead do formulário do Google Ads (lead_form_submission_data.submission_date_time).
//
// A documentação da API descreve o formato como "yyyy-mm-dd hh:mm:ss+|-hh:mm", com fuso
// (ex.: "2019-01-01 12:32:45-08:00"). A sincronização convertia com
// new Date(valor.replace(" ", "T") + "Z"): com fuso isso vira "...-08:00Z", uma data
// inválida, e o .toISOString() seguinte lançava RangeError no meio do laço de importação —
// derrubando a sincronização inteira do Google (campanhas e leads) a cada ciclo de 30 minutos
// até o lead sair da janela de 30 dias.
//
// Aqui aceitamos os dois formatos:
// - com fuso (ou "Z"): respeita o fuso;
// - sem fuso: trata como UTC, que é o que a plataforma sempre fez (os leads já importados
//   seguem esse critério, então não muda nada para eles).
// Valor ilegível devolve null, e quem chama usa o horário da importação em vez de falhar.

const FORMATO_DATA_LEAD_GOOGLE =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

export function converterDataEnvioLeadGoogle(valor: unknown): string | null {
  const texto = String(valor ?? "").trim();
  if (!texto) return null;

  const partes = texto.match(FORMATO_DATA_LEAD_GOOGLE);
  if (!partes) return null;

  const [, data, hora, fracao = "", fusoBruto = "Z"] = partes;
  let fuso = fusoBruto.toUpperCase();
  if (/^[+-]\d{4}$/.test(fuso)) fuso = `${fuso.slice(0, 3)}:${fuso.slice(3)}`;

  // Milissegundos: o JavaScript só entende até 3 casas.
  const instante = new Date(`${data}T${hora}${fracao.slice(0, 4)}${fuso}`);
  return Number.isNaN(instante.getTime()) ? null : instante.toISOString();
}
