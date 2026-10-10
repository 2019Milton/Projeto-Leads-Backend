/**
 * Guardas do fluxo legado de edição de campanhas importadas da Meta.
 * Evitam reenviar janela de atribuição antiga e repetir requests sob limite.
 */
export function atribuirJanelaSomenteSeSolicitada(
  configuracao: unknown,
  alteradaPeloUsuario: unknown
): {attribution_spec?: Array<{event_type:string;window_days:number}>} {
  if (alteradaPeloUsuario !== true) return {};
  const janelas:Record<string, Array<{event_type:string;window_days:number}>>={
    "1d_click":[{event_type:"CLICK_THROUGH",window_days:1}],
    "7d_click":[{event_type:"CLICK_THROUGH",window_days:7}],
    "28d_click":[{event_type:"CLICK_THROUGH",window_days:28}],
    "1d_click_1d_view":[
      {event_type:"CLICK_THROUGH",window_days:1},
      {event_type:"VIEW_THROUGH",window_days:1}
    ],
    "7d_click_1d_view":[
      {event_type:"CLICK_THROUGH",window_days:7},
      {event_type:"VIEW_THROUGH",window_days:1}
    ]
  };
  const val=String(configuracao??"");
  if(!val)return {};
  if(!janelas[val])throw new Error("Janela de atribuição selecionada é inválida.");
  return {attribution_spec:janelas[val]};
}

export function erroMetaLimiteChamadas(dados:unknown):boolean {
  const d=(dados&&typeof dados==="object")?dados as Record<string,any>:{};
  const error=(d.error&&typeof d.error==="object")?d.error:{};
  const code=Number(error.code||0);
  const message=String(error.message||error.error_user_msg||"");
  return code===613||(/calls to this api.*rate limit/i.test(message));
}

export const MENSAGEM_LIMITE_META =
  "A Meta limitou temporariamente as solicitações desta conta (erro 613). " +
  "Aguarde pelo menos 30 segundos antes de tentar novamente. " +
  "As alterações desta tentativa não foram confirmadas; confira a campanha na Meta antes de repetir.";
