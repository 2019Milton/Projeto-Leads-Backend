/**
 * OAuth Instagram Login: somente leituras de perfil e troca de token.
 * Os parâmetros privados nunca devem ser escritos em logs.
 */
export const AVISO_INSTAGRAM_ACESSO =
  "O Instagram autorizou o acesso, mas a API da Meta recusou consultar os dados da conta (código 100). " +
  "Confira se o aplicativo da Plataforma de Leads tem acesso avançado à permissão instagram_business_basic. " +
  "Se estiver em modo de desenvolvimento, confira se a conta profissional foi adicionada como testadora e aceitou o convite.";

type InstagramRequest = (url: string, init?: RequestInit) => Promise<Response>;
type InstagramPayload = Record<string, any>;

type EtapaInstagram = "short_token" | "long_token_get" | "long_token_post" | "profile_me" | "profile_id";
export type DiagnosticoInstagram = {
  etapa: EtapaInstagram;
  resultado: "sucesso" | "erro_api" | "resposta_invalida" | "erro_rede" | "perfil_divergente";
  status_http: number | null;
  codigo: number | null;
  subcodigo: number | null;
  tipo: string | null;
  motivo: string | null;
  fbtrace_id: string | null;
  identidade?: "id" | "user_id" | "ambos" | "nenhum" | "campos_ausentes";
};
type RegistrarDiagnostico = (evento: DiagnosticoInstagram) => void;

// A mensagem original pode conter dados privados. Registramos somente categorias
// conhecidas e campos estritamente permitidos, nunca payloads, URLs ou credenciais.
function motivoSeguro(mensagem: unknown): string | null {
  if (typeof mensagem !== "string") return null;
  if (/unsupported request\s*-\s*method type:\s*get\b/i.test(mensagem)) return "metodo_get_nao_suportado";
  if (/unsupported request\s*-\s*method type:\s*post\b/i.test(mensagem)) return "metodo_post_nao_suportado";
  if (/unsupported get request/i.test(mensagem)) return "consulta_get_nao_suportada";
  if (/expired|expirad/i.test(mensagem)) return "token_expirado";
  if (/access token|oauth token/i.test(mensagem)) return "token_recusado";
  if (/permission|not authorized|access denied/i.test(mensagem)) return "acesso_recusado";
  return "outro_erro_meta";
}

export function criarDiagnosticoInstagram(
  etapa: EtapaInstagram, status: number | null, dados: InstagramPayload,
  resultado: DiagnosticoInstagram["resultado"]
): DiagnosticoInstagram {
  const erro = dados?.error;
  const numero = (valor: unknown) => typeof valor === "number" && Number.isSafeInteger(valor) ? valor : null;
  const texto = (valor: unknown, formato: RegExp) => typeof valor === "string" && formato.test(valor) ? valor : null;
  return {
    etapa, resultado, status_http: status,
    codigo: numero(erro?.code), subcodigo: numero(erro?.error_subcode),
    tipo: texto(erro?.type, /^(?:IGApiException|OAuthException|GraphMethodException|FacebookApiException)$/),
    motivo: erro ? motivoSeguro(erro.message) : null,
    fbtrace_id: texto(erro?.fbtrace_id, /^[A-Za-z0-9_-]{1,64}$/)
  };
}

export class ErroOAuthInstagram extends Error {
  constructor(mensagem: string, readonly diagnostico: DiagnosticoInstagram) {
    super(mensagem);
    this.name = "ErroOAuthInstagram";
  }
}

async function consultarInstagram(
  etapa: EtapaInstagram, url: string, init: RequestInit | undefined,
  solicitar: InstagramRequest, registrar?: RegistrarDiagnostico
): Promise<{ resposta: Response; dados: InstagramPayload }> {
  try {
    const resposta = await solicitar(url, init);
    return { resposta, dados: await lerJson(resposta) };
  } catch {
    const diagnostico = criarDiagnosticoInstagram(etapa, null, {}, "erro_rede");
    registrar?.(diagnostico);
    throw new ErroOAuthInstagram("Não foi possível consultar a API do Instagram. Tente novamente.", diagnostico);
  }
}

function erroInstagram(retorno: InstagramPayload): string {
  const codigo = Number(retorno?.error?.code || 0);
  if (codigo === 100) return AVISO_INSTAGRAM_ACESSO;
  if (retorno?.error) return "A API do Instagram recusou a solicitação. Verifique as permissões da integração.";
  return "Resposta inválida da API do Instagram.";
}

async function lerJson(res: Response): Promise<InstagramPayload> {
  try {
    const dados = await res.json();
    return dados && typeof dados === "object" ? dados : {};
  } catch {
    return {};
  }
}

export async function trocarTokenLongoInstagram(
  tokenCurto: string, segredo: string, solicitar: InstagramRequest = fetch,
  registrar?: RegistrarDiagnostico
): Promise<string> {
  if (!tokenCurto || !segredo) throw new Error("Configuração da conexão Instagram incompleta.");
  const parametros = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: segredo,
    access_token: tokenCurto
  });
  const consultaGet = await consultarInstagram("long_token_get",
    "https://graph.instagram.com/access_token?" + parametros.toString(), undefined, solicitar, registrar);
  const respostaGet = consultaGet.resposta;
  let dados = consultaGet.dados;
  let diagnostico = criarDiagnosticoInstagram("long_token_get", respostaGet.status, dados,
    dados.error || !respostaGet.ok ? "erro_api" : "resposta_invalida");
  if (respostaGet.ok && typeof dados.access_token === "string" && dados.access_token) {
    registrar?.({ ...diagnostico, resultado: "sucesso" });
    return dados.access_token;
  }
  registrar?.(diagnostico);

  // Algumas contas recebem IGApiException 100 "method type: get" neste endpoint.
  // POST é uma alternativa apenas para troca de token (nunca para leitura do perfil).
  if (Number(dados?.error?.code) === 100 &&
      /method type:\s*get/i.test(String(dados?.error?.message || ""))) {
    const consultaPost = await consultarInstagram("long_token_post", "https://graph.instagram.com/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: parametros.toString()
    }, solicitar, registrar);
    const respostaPost = consultaPost.resposta;
    dados = consultaPost.dados;
    diagnostico = criarDiagnosticoInstagram("long_token_post", respostaPost.status, dados,
      dados.error || !respostaPost.ok ? "erro_api" : "resposta_invalida");
    if (respostaPost.ok && typeof dados.access_token === "string" && dados.access_token) {
      registrar?.({ ...diagnostico, resultado: "sucesso" });
      return dados.access_token;
    }
    registrar?.(diagnostico);
  }
  throw new ErroOAuthInstagram(erroInstagram(dados), diagnostico);
}

export type PerfilInstagramValidado = {
  user_id: string;
  username: string;
  profile_picture_url: string | null;
};
export async function buscarPerfilInstagram(
  token: string, usuarioId: string, solicitar: InstagramRequest = fetch,
  registrar?: RegistrarDiagnostico
): Promise<PerfilInstagramValidado> {
  if (!token || !/^\d+$/.test(usuarioId)) throw new Error("Identificação do Instagram inválida.");
  const campos = "id,user_id,username,account_type,profile_picture_url";
  const urls = [
    "https://graph.instagram.com/v25.0/me?fields=" + campos + "&access_token=" + encodeURIComponent(token),
    "https://graph.instagram.com/v25.0/" + encodeURIComponent(usuarioId) +
      "?fields=" + campos + "&access_token=" + encodeURIComponent(token)
  ];
  let ultimoErro: InstagramPayload = {};
  let diagnostico = criarDiagnosticoInstagram("profile_me", null, {}, "resposta_invalida");
  for (const [indice, url] of urls.entries()) {
    const etapa = indice === 0 ? "profile_me" : "profile_id";
    const consulta = await consultarInstagram(etapa, url, undefined, solicitar, registrar);
    const resposta = consulta.resposta;
    const perfil = consulta.dados;
    diagnostico = criarDiagnosticoInstagram(etapa, resposta.status, perfil,
      perfil.error || !resposta.ok ? "erro_api" : "resposta_invalida");
    if (resposta.ok && !perfil.error &&
        (perfil.user_id || perfil.id) &&
        typeof perfil.username === "string" && perfil.username.trim()) {
      // A API pode devolver id escopado ao app e user_id da conta.
      // Aceitar apenas correspondencia exata com um ID devolvido pelo perfil
      // autenticado, nunca somente pelo nome de usuario.
      const idsRecebidos = [perfil.id, perfil.user_id]
        .filter((valor): valor is string | number =>
          (typeof valor === "string" && /^\d+$/.test(valor)) ||
          (typeof valor === "number" && Number.isSafeInteger(valor) && valor >= 0))
        .map(String);
      const recebidoId = idsRecebidos.includes(usuarioId) ? usuarioId : "";
      const idCorresponde = String(perfil.id ?? "") === usuarioId;
      const userIdCorresponde = String(perfil.user_id ?? "") === usuarioId;
      diagnostico = { ...diagnostico, identidade:
        idCorresponde && userIdCorresponde ? "ambos" :
        idCorresponde ? "id" : userIdCorresponde ? "user_id" : "nenhum" };
      // Uma conta diferente nunca pode substituir o usuário autenticado.
      if (!recebidoId) {
        diagnostico = { ...diagnostico, resultado: "perfil_divergente" };
        registrar?.(diagnostico);
        throw new ErroOAuthInstagram("A conta do Instagram retornada difere da conta autorizada. Tente novamente.", diagnostico);
      }
      registrar?.({ ...diagnostico, resultado: "sucesso" });
      return {
        user_id: recebidoId,
        username: perfil.username.trim(),
        profile_picture_url: typeof perfil.profile_picture_url === "string"
          ? perfil.profile_picture_url : null
      };
    }
    registrar?.(diagnostico);
    ultimoErro = perfil;
    // O segundo caminho somente é necessário para erros de endpoint GET (100).
    if (Number(perfil?.error?.code) !== 100) break;
  }
  throw new ErroOAuthInstagram(erroInstagram(ultimoErro), diagnostico);
}
