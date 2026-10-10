import {test,expect} from "bun:test";
import {atribuirJanelaSomenteSeSolicitada,erroMetaLimiteChamadas,MENSAGEM_LIMITE_META} from "./meta-edicao-seguranca";

test("janela herdada de 7 dias nunca volta para Meta quando usuário só salva",()=>{
 expect(atribuirJanelaSomenteSeSolicitada("7d_click",false)).toEqual({});
 expect(atribuirJanelaSomenteSeSolicitada("7d_click",undefined)).toEqual({});
 expect(atribuirJanelaSomenteSeSolicitada("7d_click","true")).toEqual({});
});

test("se usuário editar a janela, somente a seleção explícita vai à Meta",()=>{
 expect(atribuirJanelaSomenteSeSolicitada("1d_click",true)).toEqual({
   attribution_spec:[{event_type:"CLICK_THROUGH",window_days:1}]
 });
 expect(atribuirJanelaSomenteSeSolicitada("7d_click",true)).toEqual({
   attribution_spec:[{event_type:"CLICK_THROUGH",window_days:7}]
 });
 expect(atribuirJanelaSomenteSeSolicitada("",true)).toEqual({});
 expect(()=>atribuirJanelaSomenteSeSolicitada("nao_valida",true)).toThrow("inválida");
});

test("erro 613 classificado como rate limit mesmo sem título do usuário",()=>{
 expect(erroMetaLimiteChamadas({error:{code:613,message:"Calls to this API have exceeded the concurrent request rate limit of 1 calls per 30 seconds."}})).toBe(true);
 expect(erroMetaLimiteChamadas({error:{code:100,error_user_msg:"A janela de atribuição é inválida."}})).toBe(false);
 expect(erroMetaLimiteChamadas({error:{code:100,error_user_msg:"Calls to this API have exceeded the concurrent request rate limit"}})).toBe(true);
 expect(erroMetaLimiteChamadas({success:true})).toBe(false);
 expect(MENSAGEM_LIMITE_META).toContain("30 segundos");
});
