import { createHash } from "node:crypto";

export function documentoAssistenteValido(valor: string): boolean {
  const doc = valor.toUpperCase().replace(/[.\/\-\s]/g, "");
  if (/^(.)\1+$/.test(doc)) return false;
  if (/^\d{11}$/.test(doc)) {
    const dv = (base: string) => {
      const resto = [...base].reduce((s, n, i) => s + Number(n) * (base.length + 1 - i), 0) % 11;
      return resto < 2 ? 0 : 11 - resto;
    };
    return dv(doc.slice(0, 9)) === Number(doc[9]) && dv(doc.slice(0, 10)) === Number(doc[10]);
  }
  // Receita Federal: CNPJ numérico e alfanumérico usam ASCII - 48 e módulo 11.
  // https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/documentos-tecnicos/cnpj/manual-dv-cnpj.pdf
  if (!/^[A-Z0-9]{12}\d{2}$/.test(doc)) return false;
  const dv = (base: string) => {
    const soma = [...base].reverse().reduce((s, c, i) => s + (c.charCodeAt(0) - 48) * (2 + i % 8), 0);
    return soma % 11 < 2 ? 0 : 11 - soma % 11;
  };
  return dv(doc.slice(0, 12)) === Number(doc[12]) && dv(doc.slice(0, 13)) === Number(doc[13]);
}

export function validarDadosAssistente(dados: Record<string, any> = {}) {
  const erros: Record<string, string> = {};
  const texto = (campo: string) => String(dados[campo] ?? "").trim();
  if (texto("nome_legal").length < 2) erros.nome_legal = "Informe o nome ou a razão social com pelo menos 2 caracteres.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(texto("email"))) erros.email = "Informe um e-mail válido, como contato@empresa.com.br.";
  const telefone = texto("telefone");
  if (!/^\+?[\d\s().-]+$/.test(telefone) || !/^[1-9]\d{9,14}$/.test(telefone.replace(/\D/g, ""))) {
    erros.telefone = "Informe um telefone com DDD; para números internacionais, inclua o código do país.";
  }
  if (texto("documento") && !documentoAssistenteValido(texto("documento"))) erros.documento = "Confira o CPF ou CNPJ informado e seus dígitos verificadores.";
  if (texto("site")) {
    try {
      const url = new URL(texto("site"));
      if (!["https:", "http:"].includes(url.protocol) || !url.hostname.includes(".") || url.username || url.password) throw new Error();
    } catch { erros.site = "Informe um endereço de site válido começando com https://."; }
  }
  if ((texto("pais") || "BR") !== "BR") erros.pais = "O assistente atende empresas do Brasil.";
  if (!["BRL", "USD"].includes(texto("moeda") || "BRL")) erros.moeda = "Escolha uma moeda disponível.";
  if (!["America/Sao_Paulo", "America/Manaus", "America/Rio_Branco"].includes(texto("fuso") || "America/Sao_Paulo")) erros.fuso = "Escolha um fuso horário disponível.";
  return erros;
}

export function sanitizarAcompanhamentoAssistente(valor: any) {
  const resultado: Record<string, any> = {};
  const texto = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
  for (const id of ["meta", "google", "tiktok"]) {
    const origem = valor?.[id];
    if (!origem || typeof origem !== "object") continue;
    resultado[id] = {
      // Apenas rótulos e estados. Imagem, valores dos campos e texto livre da IA não são persistidos.
      checklist: (Array.isArray(origem.checklist) ? origem.checklist : []).slice(0, 40).map((item: any) => ({
        nome: texto(item?.nome, 100),
        status: ["preenchido", "faltando", "atencao", "nao_aplicavel"].includes(item?.status) ? item.status : "atencao",
      })).filter((item: any) => item.nome),
      historico: (Array.isArray(origem.historico) ? origem.historico : []).slice(-12).map((item: any) => ({ etapa: texto(item?.etapa, 120) })).filter((item: any) => item.etapa),
      atualizado_em: Number.isFinite(Date.parse(origem.atualizado_em)) ? new Date(origem.atualizado_em).toISOString() : null,
    };
  }
  return resultado;
}

type Query = (sql: string, params: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
type ContaGoogle = { nome: string; moeda: string; fuso: string; managerCustomerId: string };

// A reserva é confirmada no banco ANTES da API. Resultado incerto nunca autoriza
// outra criação. Repetições com um ID conhecido refazem somente o vínculo local.
export async function criarContaGoogleAssistente(deps: {
  query: Query; usuarioId: number; dados: ContaGoogle;
  criar: () => Promise<{ ok: boolean; status: number; data: any }>;
}) {
  const { query, usuarioId, dados } = deps;
  const chave = createHash("sha256").update(JSON.stringify(dados)).digest("hex");
  const pendente = (id?: string | null) => ({ status: 409, data: {
    error: "Existe uma criação que precisa ser conferida. Abra o Google Ads e selecione a conta criada nos detalhes da integração. Se não encontrar a conta, solicite a revisão pelo suporte antes de tentar criar outra.",
    codigo: "CRIACAO_PENDENTE", customer_id: id || null,
  } });
  const reserva = await query(
    `INSERT INTO assistente_contas_criacoes (usuario_id, plataforma, chave, estado, dados)
     VALUES ($1, 'google', $2, 'em_andamento', $3::jsonb)
     ON CONFLICT DO NOTHING RETURNING *`, [usuarioId, chave, JSON.stringify(dados)]
  );
  let operacao = reserva.rows[0];
  let executar = Boolean(operacao);
  if (!operacao) {
    const existente = await query(
      `SELECT * FROM assistente_contas_criacoes WHERE usuario_id = $1 AND plataforma = 'google'
       AND (chave = $2 OR estado IN ('em_andamento', 'incerta', 'criada')) ORDER BY (chave = $2) DESC LIMIT 1`, [usuarioId, chave]
    );
    operacao = existente.rows[0];
    if (!operacao || operacao.chave !== chave) return pendente(operacao?.customer_id);
    if (!operacao.customer_id) {
      if (operacao.estado !== "recusada") return pendente();
      const retomada = await query(
        `UPDATE assistente_contas_criacoes SET estado = 'em_andamento', atualizado_em = NOW()
         WHERE usuario_id = $1 AND chave = $2 AND estado = 'recusada' RETURNING *`, [usuarioId, chave]
      ).catch((err: any) => {
        // Outra solicitação pode ter reservado a vaga após a consulta.
        if (err?.code === "23505") return { rows: [] };
        throw err;
      });
      if (!retomada.rows.length) return pendente();
      executar = true;
    }
  }
  let customerId = operacao.customer_id as string | undefined;
  if (executar) {
    try {
      const resposta = await deps.criar();
      if (!resposta.ok) {
        // Somente uma rejeição explícita 4xx permite uma nova tentativa.
        const recusada = resposta.status >= 400 && resposta.status < 500 && ![408, 409, 429].includes(resposta.status);
        await query(`UPDATE assistente_contas_criacoes SET estado = $3, atualizado_em = NOW() WHERE usuario_id = $1 AND chave = $2`, [usuarioId, chave, recusada ? "recusada" : "incerta"]);
        if (!recusada) return pendente();
        return { status: 400, data: { error: resposta.data?.error?.details?.[0]?.errors?.[0]?.message || resposta.data?.error?.message || "O Google Ads recusou a criação da conta." } };
      }
      const match = /^customers\/(\d+)$/.exec(String(resposta.data?.resourceName || ""));
      if (!match) throw new Error("Resposta de criação sem identificador válido");
      customerId = match[1];
      await query(`UPDATE assistente_contas_criacoes SET customer_id = $3, estado = 'criada', atualizado_em = NOW() WHERE usuario_id = $1 AND chave = $2`, [usuarioId, chave, customerId]);
    } catch {
      // Mesmo se o banco estiver indisponível, a reserva anterior bloqueia recriação.
      if (!customerId) {
        await query(`UPDATE assistente_contas_criacoes SET estado = 'incerta', atualizado_em = NOW() WHERE usuario_id = $1 AND chave = $2`, [usuarioId, chave]).catch(() => {});
        return pendente();
      }
      return { status: 202, data: { sucesso: false, vinculo_pendente: true, customer_id: customerId, aviso: "Conta criada no Google Ads. A gravação ficou pendente; abra os detalhes da integração e selecione esta conta. Não crie outra." } };
    }
  }
  try {
    const vinculo = await query(
      `UPDATE plataforma_conexoes SET dados_conta = COALESCE(dados_conta, '{}'::jsonb) || jsonb_build_object(
       'customer_id', $1::text, 'login_customer_id', $2::text, 'criada_pelo_assistente', true), atualizado_em = NOW()
       WHERE usuario_id = $3 AND plataforma = 'google' AND status = 'conectado' RETURNING usuario_id`,
      [customerId, dados.managerCustomerId, usuarioId]
    );
    if (!vinculo.rows.length) throw new Error("Conexão indisponível para vínculo");
    await query(`UPDATE assistente_contas_criacoes SET estado = 'vinculada', atualizado_em = NOW() WHERE usuario_id = $1 AND chave = $2`, [usuarioId, chave]);
    return { status: 200, data: { sucesso: true, customer_id: customerId, reutilizada: !executar, aviso: "Conta selecionada. Confira pagamento, verificação do anunciante e permissões no Google Ads antes de publicar." } };
  } catch {
    return { status: 202, data: { sucesso: false, vinculo_pendente: true, customer_id: customerId, aviso: "A conta já existe no Google Ads, mas o vínculo está pendente. Tente novamente para recuperar o vínculo ou selecione a conta nos detalhes da integração." } };
  }
}
