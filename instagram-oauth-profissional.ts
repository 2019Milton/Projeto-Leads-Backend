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
  tokenCurto: string, segredo: string, solicitar: InstagramRequest = fetch
): Promise<string> {
  if (!tokenCurto || !segredo) throw new Error("Configuração da conexão Instagram incompleta.");
  const parametros = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: segredo,
    access_token: tokenCurto
  });
  const respostaGet = await solicitar("https://graph.instagram.com/access_token?" + parametros.toString());
  let dados = await lerJson(respostaGet);
  if (respostaGet.ok && typeof dados.access_token === "string" && dados.access_token) {
    return dados.access_token;
  }

  // Algumas contas recebem IGApiException 100 "method type: get" neste endpoint.
  // POST é uma alternativa apenas para troca de token (nunca para leitura do perfil).
  if (Number(dados?.error?.code) === 100 &&
      /method type:\s*get/i.test(String(dados?.error?.message || ""))) {
    const respostaPost = await solicitar("https://graph.instagram.com/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: parametros.toString()
    });
    dados = await lerJson(respostaPost);
    if (respostaPost.ok && typeof dados.access_token === "string" && dados.access_token) {
      return dados.access_token;
    }
  }
  throw new Error(erroInstagram(dados));
}

export type PerfilInstagramValidado = {
  user_id: string;
  username: string;
  profile_picture_url: string | null;
};
export async function buscarPerfilInstagram(
  token: string, usuarioId: string, solicitar: InstagramRequest = fetch
): Promise<PerfilInstagramValidado> {
  if (!token || !/^\d+$/.test(usuarioId)) throw new Error("Identificação do Instagram inválida.");
  const campos = "user_id,username,account_type,profile_picture_url";
  const urls = [
    "https://graph.instagram.com/v25.0/me?fields=" + campos + "&access_token=" + encodeURIComponent(token),
    "https://graph.instagram.com/v25.0/" + encodeURIComponent(usuarioId) +
      "?fields=" + campos + "&access_token=" + encodeURIComponent(token)
  ];
  let ultimoErro: InstagramPayload = {};
  for (const url of urls) {
    const resposta = await solicitar(url);
    const perfil = await lerJson(resposta);
    if (resposta.ok && !perfil.error &&
        (perfil.user_id || perfil.id) &&
        typeof perfil.username === "string" && perfil.username.trim()) {
      const recebidoId = String(perfil.user_id || perfil.id);
      // Uma conta diferente nunca pode substituir o usuário autenticado.
      if (recebidoId !== usuarioId) {
        throw new Error("A conta do Instagram retornada difere da conta autorizada. Tente novamente.");
      }
      return {
        user_id: recebidoId,
        username: perfil.username.trim(),
        profile_picture_url: typeof perfil.profile_picture_url === "string"
          ? perfil.profile_picture_url : null
      };
    }
    ultimoErro = perfil;
    // O segundo caminho somente é necessário para erros de endpoint GET (100).
    if (Number(perfil?.error?.code) !== 100) break;
  }
  throw new Error(erroInstagram(ultimoErro));
}
