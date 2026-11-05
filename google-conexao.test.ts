import { expect, test } from "bun:test";
import {
  CHAVES_DADOS_CONTA_GOOGLE_DA_CONTA,
  contaSalvaGoogleAindaAcessivel,
  dadosContaGoogleAposReconexao,
  escaparLiteralGaql,
  idsContasGoogleAcessiveis,
  obterOuCriarAcaoConversaoGoogle,
  refreshTokenGoogleAposReconexao,
  resourceNameAcaoDaConta,
  type DepsAcaoConversaoGoogle
} from "./google-conexao";

// ---------- reconexão: o que fica em dados_conta ----------

const dadosCompletos = () => ({
  customer_id: "7772651015",
  login_customer_id: "5550001111",
  conversion_action_qualified_id: "customers/7772651015/conversionActions/11",
  conversion_action_closed_id: "customers/7772651015/conversionActions/22",
  google_tag_site: { customer_id: "7772651015", send_to: "AW-1234567/AbCd_1234" },
  campo_de_outra_funcao: "fica"
});

test("lê os ids de customers:listAccessibleCustomers", () => {
  expect([...idsContasGoogleAcessiveis(["customers/5550001111", "customers/42", "lixo", "", null])]).toEqual(["5550001111", "42"]);
  expect(idsContasGoogleAcessiveis(undefined).size).toBe(0);
  expect(idsContasGoogleAcessiveis("customers/1").size).toBe(0);
});

test("reconectar com o mesmo login Google preserva a conta, a MCC, as ações e a tag", () => {
  const depois = dadosContaGoogleAposReconexao(dadosCompletos(), new Set(["5550001111"]));
  expect(depois).toEqual(dadosCompletos());
});

test("conta direta (sem MCC) acessível também preserva tudo", () => {
  const direta = { customer_id: "7772651015", conversion_action_qualified_id: "customers/7772651015/conversionActions/11" };
  expect(dadosContaGoogleAposReconexao(direta, new Set(["7772651015"]))).toEqual(direta);
});

test("não conseguiu conferir (falha na API do Google) → preserva tudo, nunca apaga por precaução", () => {
  expect(dadosContaGoogleAposReconexao(dadosCompletos(), null)).toEqual(dadosCompletos());
});

test("reconectou com OUTRO login Google (MCC antiga fora da lista) → descarta só o que era da conta antiga", () => {
  const depois = dadosContaGoogleAposReconexao(dadosCompletos(), new Set(["999"]));
  for (const chave of CHAVES_DADOS_CONTA_GOOGLE_DA_CONTA) expect(chave in depois).toBe(false);
  expect(depois).toEqual({ campo_de_outra_funcao: "fica" });
});

test("lista de contas vazia também conta como conta salva inacessível", () => {
  expect(contaSalvaGoogleAindaAcessivel(dadosCompletos(), new Set())).toBe(false);
  expect(dadosContaGoogleAposReconexao(dadosCompletos(), new Set())).toEqual({ campo_de_outra_funcao: "fica" });
});

test("sem conta salva não há o que invalidar; dados antigos ausentes/estranhos viram objeto vazio", () => {
  expect(contaSalvaGoogleAindaAcessivel({}, new Set())).toBe(true);
  expect(dadosContaGoogleAposReconexao(null, new Set(["1"]))).toEqual({});
  expect(dadosContaGoogleAposReconexao(undefined, null)).toEqual({});
  expect(dadosContaGoogleAposReconexao([1, 2], new Set(["1"]))).toEqual({});
  expect(dadosContaGoogleAposReconexao("texto", null)).toEqual({});
});

test("a entrada nunca é alterada", () => {
  const original = dadosCompletos();
  dadosContaGoogleAposReconexao(original, new Set(["999"]));
  expect(original).toEqual(dadosCompletos());
});

test("refresh_token: o novo vence; sem novo mantém o anterior; nenhum → null", () => {
  expect(refreshTokenGoogleAposReconexao("novo", "velho")).toBe("novo");
  expect(refreshTokenGoogleAposReconexao("", "velho")).toBe("velho");
  expect(refreshTokenGoogleAposReconexao(null, "velho")).toBe("velho");
  expect(refreshTokenGoogleAposReconexao(undefined, undefined)).toBeNull();
  expect(refreshTokenGoogleAposReconexao("  ", "")).toBeNull();
});

// ---------- ação de conversão ----------

test("resource name de ação só vale para a própria conta", () => {
  expect(resourceNameAcaoDaConta("customers/123/conversionActions/9", "123")).toBe(true);
  expect(resourceNameAcaoDaConta("customers/123/conversionActions/9", "123-000")).toBe(false);
  expect(resourceNameAcaoDaConta("customers/123/conversionActions/9", "124")).toBe(false);
  expect(resourceNameAcaoDaConta("customers/123/campaigns/9", "123")).toBe(false);
  expect(resourceNameAcaoDaConta("", "123")).toBe(false);
  expect(resourceNameAcaoDaConta(null, "123")).toBe(false);
});

test("literal GAQL escapa aspas e barras", () => {
  expect(escaparLiteralGaql("Plataforma de Leads - Qualified Lead")).toBe("Plataforma de Leads - Qualified Lead");
  expect(escaparLiteralGaql("a'b\\c")).toBe("a\\'b\\\\c");
});

function montarDeps(
  dados: Record<string, any> | null,
  extra: Partial<DepsAcaoConversaoGoogle> = {}
) {
  const registro = { gravados: [] as Array<[string, string]>, buscas: [] as string[], criacoes: [] as Array<[string, string]>, avisos: [] as string[] };
  const deps: DepsAcaoConversaoGoogle = {
    lerDadosConta: async () => dados,
    gravarCampo: async (campo, valor) => { registro.gravados.push([campo, valor]); },
    buscarPorNome: async (nome) => { registro.buscas.push(nome); return null; },
    criar: async (nome, categoria) => { registro.criacoes.push([nome, categoria]); return "customers/123/conversionActions/777"; },
    aviso: (mensagem) => { registro.avisos.push(mensagem); },
    ...extra
  };
  return { deps, registro };
}

const params = { customerId: "123", chave: "qualified" as const, nomeEvento: "Qualified Lead", categoria: "QUALIFIED_LEAD" };

test("usa a ação guardada quando é da conta atual — sem consultar nem criar nada", async () => {
  const { deps, registro } = montarDeps({ conversion_action_qualified_id: "customers/123/conversionActions/55" });
  expect(await obterOuCriarAcaoConversaoGoogle(deps, params)).toBe("customers/123/conversionActions/55");
  expect(registro).toEqual({ gravados: [], buscas: [], criacoes: [], avisos: [] });
});

test("ação guardada de OUTRA conta é ignorada: reaproveita a de mesmo nome na conta atual", async () => {
  const { deps, registro } = montarDeps({ conversion_action_qualified_id: "customers/999/conversionActions/55" });
  deps.buscarPorNome = async (nome) => {
    registro.buscas.push(nome);
    return "customers/123/conversionActions/31";
  };
  expect(await obterOuCriarAcaoConversaoGoogle(deps, params)).toBe("customers/123/conversionActions/31");
  expect(registro.buscas).toEqual(["Plataforma de Leads - Qualified Lead"]);
  expect(registro.criacoes).toEqual([]);
  expect(registro.gravados).toEqual([["conversion_action_qualified_id", "customers/123/conversionActions/31"]]);
});

test("depois de reconectar (id perdido) reaproveita a ação que já existe no Google e não tenta criar de novo", async () => {
  const { deps, registro } = montarDeps({}, { buscarPorNome: async () => "customers/123/conversionActions/31" });
  expect(await obterOuCriarAcaoConversaoGoogle(deps, params)).toBe("customers/123/conversionActions/31");
  expect(registro.criacoes).toEqual([]);
  expect(registro.gravados).toEqual([["conversion_action_qualified_id", "customers/123/conversionActions/31"]]);
});

test("não existe nem no Google: cria com a categoria própria e grava o id", async () => {
  const { deps, registro } = montarDeps({});
  expect(await obterOuCriarAcaoConversaoGoogle(deps, params)).toBe("customers/123/conversionActions/777");
  expect(registro.buscas).toEqual(["Plataforma de Leads - Qualified Lead"]);
  expect(registro.criacoes).toEqual([["Plataforma de Leads - Qualified Lead", "QUALIFIED_LEAD"]]);
  expect(registro.gravados).toEqual([["conversion_action_qualified_id", "customers/123/conversionActions/777"]]);
});

test("fechamento usa o campo e o nome do 'Closed Won'", async () => {
  const { deps, registro } = montarDeps({});
  await obterOuCriarAcaoConversaoGoogle(deps, { customerId: "123", chave: "closed", nomeEvento: "Closed Won", categoria: "CONVERTED_LEAD" });
  expect(registro.criacoes).toEqual([["Plataforma de Leads - Closed Won", "CONVERTED_LEAD"]]);
  expect(registro.gravados[0][0]).toBe("conversion_action_closed_id");
});

test("conta recusa a categoria: cai em DEFAULT", async () => {
  const { deps, registro } = montarDeps({});
  deps.criar = async (nome, categoria) => {
    registro.criacoes.push([nome, categoria]);
    if (categoria !== "DEFAULT") throw new Error("categoria inválida");
    return "customers/123/conversionActions/888";
  };
  expect(await obterOuCriarAcaoConversaoGoogle(deps, params)).toBe("customers/123/conversionActions/888");
  expect(registro.criacoes.map(([, categoria]) => categoria)).toEqual(["QUALIFIED_LEAD", "DEFAULT"]);
  expect(registro.avisos.length).toBe(1);
  expect(registro.gravados).toEqual([["conversion_action_qualified_id", "customers/123/conversionActions/888"]]);
});

test("a busca por nome falhou: ainda tenta criar (comportamento de antes), sem lançar", async () => {
  const { deps, registro } = montarDeps({}, { buscarPorNome: async () => { throw new Error("PERMISSION_DENIED"); } });
  expect(await obterOuCriarAcaoConversaoGoogle(deps, params)).toBe("customers/123/conversionActions/777");
  expect(registro.avisos.length).toBe(1);
  expect(registro.criacoes.length).toBe(1);
});

test("sem conexão Google → null, sem tocar no Google", async () => {
  const { deps, registro } = montarDeps(null);
  expect(await obterOuCriarAcaoConversaoGoogle(deps, params)).toBeNull();
  expect(registro).toEqual({ gravados: [], buscas: [], criacoes: [], avisos: [] });
});

test("criar devolve vazio → null e não grava nada", async () => {
  const { deps, registro } = montarDeps({}, { criar: async () => null });
  expect(await obterOuCriarAcaoConversaoGoogle(deps, params)).toBeNull();
  expect(registro.gravados).toEqual([]);
});

test("falha da criação em DEFAULT também propaga (quem chama trata e devolve null)", async () => {
  const { deps } = montarDeps({}, { criar: async () => { throw new Error("DUPLICATE_NAME"); } });
  await expect(obterOuCriarAcaoConversaoGoogle(deps, params)).rejects.toThrow("DUPLICATE_NAME");
});

// ---------- aviso "Reconecte o Google Ads" ----------

import { avisoReconexaoGoogle } from "./google-conexao";

const ESCOPO_ADWORDS = "https://www.googleapis.com/auth/adwords";
const ESCOPO_DATAMANAGER = "https://www.googleapis.com/auth/datamanager";

test("token revogado/expirado (invalid_grant) pede reconexão, com a flag ligada ou não", () => {
  expect(avisoReconexaoGoogle({ erroCodigo: "invalid_grant", pedirDatamanager: false })?.motivo).toBe("token_revogado");
  expect(avisoReconexaoGoogle({ erroCodigo: "invalid_grant", escopo: ESCOPO_ADWORDS, pedirDatamanager: true })?.motivo).toBe("token_revogado");
});

test("flag do datamanager ligada e conexão só com adwords → pede reconexão para ganhar a permissão", () => {
  const aviso = avisoReconexaoGoogle({ escopo: ESCOPO_ADWORDS, pedirDatamanager: true });
  expect(aviso?.motivo).toBe("sem_permissao_conversoes");
  expect(aviso?.mensagem).toContain("reconecte o Google Ads");
});

test("flag ligada e conexão que já tem o datamanager → sem aviso", () => {
  expect(avisoReconexaoGoogle({ escopo: `${ESCOPO_ADWORDS} ${ESCOPO_DATAMANAGER}`, pedirDatamanager: true })).toBeNull();
  expect(avisoReconexaoGoogle({ escopo: `${ESCOPO_DATAMANAGER}  ${ESCOPO_ADWORDS}`, pedirDatamanager: true })).toBeNull();
});

test("flag desligada nunca pede reconexão por permissão (o Google bloquearia o consentimento)", () => {
  expect(avisoReconexaoGoogle({ escopo: ESCOPO_ADWORDS, pedirDatamanager: false })).toBeNull();
});

test("escopo desconhecido ou outros erros não afirmam nada", () => {
  expect(avisoReconexaoGoogle({ pedirDatamanager: true })).toBeNull();
  expect(avisoReconexaoGoogle({ escopo: "", pedirDatamanager: true })).toBeNull();
  expect(avisoReconexaoGoogle({ escopo: null, pedirDatamanager: true })).toBeNull();
  expect(avisoReconexaoGoogle({ erroCodigo: "invalid_client", pedirDatamanager: true })).toBeNull();
  expect(avisoReconexaoGoogle({ erroCodigo: undefined, pedirDatamanager: false })).toBeNull();
});

test("o escopo datamanager precisa ser exatamente esse, não um parecido", () => {
  expect(avisoReconexaoGoogle({ escopo: `${ESCOPO_ADWORDS} https://www.googleapis.com/auth/datamanager.readonly`, pedirDatamanager: true })?.motivo).toBe("sem_permissao_conversoes");
});
