export type EstadoAutorizacao = "autorizado" | "pendente" | "indeterminado";
export type Evidencia = {
  instagramId?: string | null;
  contaAnunciosId?: string | null;
  consultaOk: boolean;
  identidadesDisponiveis?: string[] | null;
  autorizacaoConfirmada?: boolean | null;
  ausenciaConfirmada?: boolean;
};
export function classificarAutorizacao(e: Evidencia): EstadoAutorizacao {
  const id = (v?: string | null) => Boolean(v && /^[0-9]+$/.test(v));
  if (!id(e.contaAnunciosId) || !id(e.instagramId) || !e.consultaOk) return "indeterminado";
  if (e.autorizacaoConfirmada === true && e.identidadesDisponiveis?.includes(e.instagramId!)) return "autorizado";
  if (e.ausenciaConfirmada === true && e.autorizacaoConfirmada === false) return "pendente";
  return "indeterminado";
}
