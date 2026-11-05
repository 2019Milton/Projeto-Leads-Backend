// Regras da conexão Google Ads que não dependem de banco nem de rede — a parte com I/O fica no
// index.ts e chama as funções daqui, que por isso dá para testar.
//
// Por que existe (conferido em 2026-11-04):
// 1) Reconectar o Google (botão "Reconectar", p.ex. para ganhar o escopo datamanager) passava por
//    um upsert que SUBSTITUÍA dados_conta inteiro: o usuário perdia a conta selecionada, a MCC, os
//    ids das ações de conversão e a tag do site, e o refresh_token era sobrescrito mesmo quando o
//    Google não devolvia outro.
// 2) Sem o id da ação de conversão guardado, criar de novo "Plataforma de Leads - Qualified Lead"
//    esbarrava em nome duplicado no Google e o evento nunca saía ("Não foi possível criar a ação
//    de conversão"). A ação existente precisa ser reaproveitada pelo nome.

// Tudo que, em dados_conta, pertence a UMA conta do Google Ads. Se a nova conexão não enxerga mais
// essa conta (outro login Google), isso é descartado; o resto do dados_conta é preservado.
export const CHAVES_DADOS_CONTA_GOOGLE_DA_CONTA = [
  "customer_id",
  "login_customer_id",
  "conversion_action_qualified_id",
  "conversion_action_closed_id",
  "google_tag_site"
] as const;

function soDigitos(valor: unknown): string {
  return String(valor ?? "").replace(/\D/g, "");
}

// "customers/123" (resposta de customers:listAccessibleCustomers) -> "123"
export function idsContasGoogleAcessiveis(resourceNames: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(resourceNames)) return ids;
  for (const recurso of resourceNames) {
    const id = soDigitos(String(recurso ?? "").split("/")[1]);
    if (id) ids.add(id);
  }
  return ids;
}

// A conta salva continua utilizável pelo novo token? Cliente dentro de uma MCC só é alcançado se
// a própria MCC estiver na lista (listAccessibleCustomers não lista os clientes dela); conta
// direta precisa estar na lista. Sem conta salva, não há o que validar.
export function contaSalvaGoogleAindaAcessivel(dadosConta: unknown, acessiveis: Set<string>): boolean {
  const dados = (dadosConta ?? {}) as Record<string, unknown>;
  const customerId = soDigitos(dados.customer_id);
  if (!customerId) return true;
  const mcc = soDigitos(dados.login_customer_id);
  return mcc ? acessiveis.has(mcc) : acessiveis.has(customerId);
}

// dados_conta que fica gravado depois de reconectar o Google.
// - acessiveis === null: não deu para conferir (falha de rede/API) -> preserva tudo, que é o
//   comportamento seguro; se a conta tiver mesmo sumido, o painel já pede para selecionar de novo.
// - conta salva ainda acessível -> preserva tudo.
// - conta salva NÃO acessível (reconectou com outro login Google) -> descarta só o que era da conta
//   antiga, para não apontar ações/tag de outra conta.
export function dadosContaGoogleAposReconexao(
  anterior: unknown,
  acessiveis: Set<string> | null
): Record<string, any> {
  const base: Record<string, any> =
    anterior && typeof anterior === "object" && !Array.isArray(anterior) ? { ...(anterior as object) } : {};
  if (acessiveis === null) return base;
  if (contaSalvaGoogleAindaAcessivel(base, acessiveis)) return base;
  for (const chave of CHAVES_DADOS_CONTA_GOOGLE_DA_CONTA) delete base[chave];
  return base;
}

// O Google sempre devolve refresh_token com prompt=consent; se algum dia não devolver, manter o
// anterior é melhor do que gravar vazio e quebrar a conexão.
export function refreshTokenGoogleAposReconexao(novo: unknown, anterior: unknown): string | null {
  const a = typeof novo === "string" ? novo.trim() : "";
  if (a) return a;
  const b = typeof anterior === "string" ? anterior.trim() : "";
  return b || null;
}

// Escapa para um literal entre aspas simples em GAQL.
export function escaparLiteralGaql(valor: string): string {
  return valor.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function nomeAcaoConversaoGoogle(nomeEvento: string): string {
  return `Plataforma de Leads - ${nomeEvento}`;
}

// "customers/123/conversionActions/456" é da conta 123?  O próprio resource name carrega a conta,
// então um id guardado de OUTRA conta (selecionada antes) é reconhecido e ignorado.
export function resourceNameAcaoDaConta(resourceName: unknown, customerId: string): boolean {
  const m = String(resourceName ?? "").match(/^customers\/(\d+)\/conversionActions\/\d+$/);
  return !!m && m[1] === soDigitos(customerId);
}

export type DepsAcaoConversaoGoogle = {
  // dados_conta da conexão Google; null = sem conexão
  lerDadosConta(): Promise<Record<string, any> | null>;
  // grava UMA chave de dados_conta sem tocar nas outras
  gravarCampo(campo: string, valor: string): Promise<void>;
  // resource name de uma ação UPLOAD_CLICKS não removida com esse nome, se existir
  buscarPorNome(nome: string): Promise<string | null>;
  criar(nome: string, categoria: string): Promise<string | null>;
  aviso(mensagem: string, detalhe?: unknown): void;
};

// Ação de conversão do evento (qualificado/fechado) na conta Google selecionada:
// 1. a guardada em dados_conta, se for da conta atual;
// 2. senão, a que já existe no Google com o mesmo nome (conexão refeita, id perdido);
// 3. senão, cria (categoria própria; se a conta recusar, cai em DEFAULT).
export async function obterOuCriarAcaoConversaoGoogle(
  deps: DepsAcaoConversaoGoogle,
  params: {
    customerId: string;
    chave: "qualified" | "closed";
    nomeEvento: string;
    categoria: string;
  }
): Promise<string | null> {
  const campo =
    params.chave === "qualified" ? "conversion_action_qualified_id" : "conversion_action_closed_id";

  const dados = await deps.lerDadosConta();
  if (!dados) return null;

  const guardada = dados[campo];
  if (guardada && resourceNameAcaoDaConta(guardada, params.customerId)) return String(guardada);

  const nome = nomeAcaoConversaoGoogle(params.nomeEvento);

  let recurso: string | null = null;
  try {
    recurso = await deps.buscarPorNome(nome);
  } catch (erro) {
    // Falha na busca não impede criar: no pior caso cai no erro de nome duplicado, como antes.
    deps.aviso("AVISO GOOGLE: não foi possível procurar a ação de conversão pelo nome:", erro);
  }

  if (!recurso) {
    try {
      recurso = await deps.criar(nome, params.categoria);
    } catch (erroCategoria: any) {
      deps.aviso(
        `AVISO GOOGLE: categoria ${params.categoria} recusada, criando a ação em DEFAULT:`,
        erroCategoria?.message
      );
      recurso = await deps.criar(nome, "DEFAULT");
    }
  }

  if (!recurso) return null;

  await deps.gravarCampo(campo, recurso);
  return recurso;
}
