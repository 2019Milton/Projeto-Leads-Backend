import { expect, test } from "bun:test";
import {
  AVISOS_WHATSAPP,
  avisoWhatsAppPorChave,
  decidirAvisoWhatsApp,
  destinatariosAvisoAdministracao,
  montarPainelAvisosWhatsApp,
  validarEscolhaAvisoWhatsApp,
  verificarAvisoWhatsApp,
} from "./avisos-whatsapp";

const novoLead = avisoWhatsAppPorChave("novo_lead")!;
const lembrete = avisoWhatsAppPorChave("lembrete_contato_hoje")!;
const suporte = avisoWhatsAppPorChave("suporte_nova_mensagem")!;

const corretor = { tipo: "corretor", ativo: true, whatsapp: "(21) 99999-0000", notif_whatsapp_lead: true };
const admin = { ...corretor, tipo: "super_admin" };

test("catálogo: chaves únicas e os 15 avisos levantados", () => {
  const chaves = AVISOS_WHATSAPP.map((a) => a.chave);
  expect(new Set(chaves).size).toBe(chaves.length);
  expect(chaves.length).toBe(15);
  expect(AVISOS_WHATSAPP.filter((a) => a.grupo === "administracao").map((a) => a.chave)).toEqual([
    "suporte_nova_mensagem",
    "ia_sem_credito",
    "ia_saldo_baixo",
    "ia_recarga_automatica",
  ]);
  expect(avisoWhatsAppPorChave("inexistente")).toBeNull();
});

test("padrão = como antes do painel: aviso da conta vai pro dono, da administração só pro super admin", () => {
  expect(decidirAvisoWhatsApp(novoLead, corretor, null)).toEqual({ envia: true, marcado: true, motivo: "recebe" });
  expect(decidirAvisoWhatsApp(suporte, corretor, null)).toEqual({ envia: false, marcado: false, motivo: "fora_do_padrao" });
  expect(decidirAvisoWhatsApp(suporte, admin, null).envia).toBe(true);
});

test("escolha do painel vale mais que o padrão", () => {
  expect(decidirAvisoWhatsApp(novoLead, corretor, false)).toEqual({ envia: false, marcado: false, motivo: "desligado_no_painel" });
  expect(decidirAvisoWhatsApp(suporte, corretor, true).envia).toBe(true);
  expect(decidirAvisoWhatsApp(suporte, admin, false).motivo).toBe("desligado_no_painel");
});

test("inativo não recebe nada, nem marcado", () => {
  const inativo = { ...corretor, ativo: false };
  expect(decidirAvisoWhatsApp(novoLead, inativo, null)).toEqual({ envia: false, marcado: true, motivo: "inativo" });
  expect(decidirAvisoWhatsApp(suporte, { ...admin, ativo: false }, true).motivo).toBe("inativo");
  // ativo null (coluna antiga) conta como ativo, igual ao COALESCE(ativo, true) do resto do sistema
  expect(decidirAvisoWhatsApp(novoLead, { ...corretor, ativo: null }, null).envia).toBe(true);
});

test("chave de notificação do próprio usuário só vale para os avisos de lead/resumo", () => {
  const desligou = { ...corretor, notif_whatsapp_lead: false };
  expect(decidirAvisoWhatsApp(novoLead, desligou, null).motivo).toBe("desligado_pelo_usuario");
  expect(decidirAvisoWhatsApp(novoLead, desligou, true).motivo).toBe("desligado_pelo_usuario");
  expect(decidirAvisoWhatsApp(lembrete, desligou, null).envia).toBe(true);
  expect(avisoWhatsAppPorChave("resumo_semanal")!.respeitaPreferenciaUsuario).toBe(true);
});

test("sem WhatsApp não envia; telefone de destino próprio (resumo → número do bot) substitui o do perfil", () => {
  const semNumero = { ...corretor, whatsapp: " - " };
  expect(decidirAvisoWhatsApp(novoLead, semNumero, null).motivo).toBe("sem_whatsapp");
  const resumo = avisoWhatsAppPorChave("resumo_semanal")!;
  expect(decidirAvisoWhatsApp(resumo, semNumero, null, "5521969099020").envia).toBe(true);
  expect(decidirAvisoWhatsApp(resumo, corretor, null, "").motivo).toBe("sem_whatsapp");
});

function bancoFalso(linhas: any[]) {
  const consultas: { sql: string; params?: unknown[] }[] = [];
  return {
    consultas,
    query: async (sql: string, params?: unknown[]) => {
      consultas.push({ sql, params });
      return { rows: linhas };
    },
  };
}

test("verificarAvisoWhatsApp lê a escolha salva e devolve o telefone só quando envia", async () => {
  const db = bancoFalso([{ ...corretor, escolha: null }]);
  expect(await verificarAvisoWhatsApp(db, "novo_lead", 16)).toEqual({ envia: true, motivo: "recebe", telefone: "(21) 99999-0000" });
  expect(db.consultas[0].params).toEqual([16, "novo_lead"]);

  const desligado = bancoFalso([{ ...corretor, escolha: false }]);
  expect(await verificarAvisoWhatsApp(desligado, "novo_lead", 16)).toEqual({ envia: false, motivo: "desligado_no_painel", telefone: "" });

  const bot = bancoFalso([{ ...corretor, escolha: null }]);
  expect((await verificarAvisoWhatsApp(bot, "resumo_semanal", 16, "5521969099020")).telefone).toBe("5521969099020");

  expect((await verificarAvisoWhatsApp(bancoFalso([]), "novo_lead", 999)).envia).toBe(false);
  await expect(verificarAvisoWhatsApp(bancoFalso([]), "xyz" as any, 1)).rejects.toThrow();
});

test("destinatários da administração descartam inativo e sem WhatsApp", async () => {
  const db = bancoFalso([
    { id: 3, ...admin, escolha: null },
    { id: 7, ...corretor, tipo: "suporte", escolha: true },
    { id: 8, ...corretor, ativo: false, escolha: true },
    { id: 9, ...admin, whatsapp: null, escolha: null },
  ]);
  expect(await destinatariosAvisoAdministracao(db, "ia_sem_credito")).toEqual([
    { usuarioId: 3, telefone: admin.whatsapp },
    { usuarioId: 7, telefone: corretor.whatsapp },
  ]);
});

test("painel: marca cada usuário, conta quem recebe e soma os envios de 30 dias", () => {
  const usuarios = [
    { id: 3, nome: "Milton", sobrenome: null, email: "a@x", ...admin },
    { id: 16, nome: "Marcos", sobrenome: "Dias", email: "m@x", ...corretor },
    { id: 10, nome: null, sobrenome: null, email: "alex@x", ...corretor, ativo: false },
  ];
  const painel = montarPainelAvisosWhatsApp(
    usuarios,
    [{ aviso: "novo_lead", usuario_id: 16, recebe: false }],
    [{ aviso: "novo_lead", enviados: 5, falhas: 1, ultimo_envio_em: "2026-10-20T10:00:00Z" }]
  );
  const lead = painel.avisos.find((a) => a.chave === "novo_lead")!;
  expect(lead.recebem).toBe(1);
  expect(lead.personalizado).toBe(true);
  expect(lead.enviados_30d).toBe(5);
  expect(lead.falhas_30d).toBe(1);
  expect(lead.destinatarios.map((d) => [d.usuario_id, d.marcado, d.recebe, d.motivo])).toEqual([
    [3, true, true, "recebe"],
    [16, false, false, "desligado_no_painel"],
    [10, true, false, "inativo"],
  ]);
  const sup = painel.avisos.find((a) => a.chave === "suporte_nova_mensagem")!;
  expect(sup.recebem).toBe(1);
  expect(sup.padrao).toBe("Super admins");
  expect(sup.enviados_30d).toBe(0);
  expect(painel.usuarios.map((u) => u.nome)).toEqual(["Milton", "Marcos Dias", "alex@x"]);
  expect(painel.usuarios[0]).not.toHaveProperty("whatsapp");
  expect(painel.usuarios[2].ativo).toBe(false);
});

test("validação do PUT", () => {
  expect(validarEscolhaAvisoWhatsApp("xyz", { usuario_ids: [1], recebe: true })).toEqual({ erro: "Aviso desconhecido" });
  expect(validarEscolhaAvisoWhatsApp("novo_lead", { usuario_ids: [], recebe: true })).toEqual({ erro: "Informe os usuários" });
  expect(validarEscolhaAvisoWhatsApp("novo_lead", { usuario_ids: [1, "a"], recebe: true })).toEqual({ erro: "Usuário inválido" });
  expect(validarEscolhaAvisoWhatsApp("novo_lead", { usuario_ids: [1] })).toEqual({ erro: "Informe se recebe ou não" });
  const ok = validarEscolhaAvisoWhatsApp("novo_lead", { usuario_ids: [3, "3", 16], recebe: null });
  expect("erro" in ok).toBe(false);
  if (!("erro" in ok)) {
    expect(ok.usuarioIds).toEqual([3, 16]);
    expect(ok.recebe).toBeNull();
    expect(ok.aviso.chave).toBe("novo_lead");
  }
});

// Garante o "ponto único": nenhum envio pelo número da plataforma escapa do painel.
test("index.ts só manda pela Z-API através de enviarAvisoWhatsApp / enviarAvisoWhatsAppAdministracao", async () => {
  const fonte = (await Bun.file(new URL("./index.ts", import.meta.url)).text()).replace(/\r\n/g, "\n");
  expect(fonte).not.toContain("enviarLembreteWhatsApp");

  const funcoes = fonte.split(/\n(?=(?:async )?function |app\.(?:get|post|put|delete)\()/);
  const comEnvioDireto = funcoes
    .filter((trecho) => /enviarTextoZapi\(/.test(trecho) && !trecho.startsWith("async function enviarTextoZapi("))
    .map((trecho) => trecho.slice(0, trecho.indexOf("(")));
  expect(comEnvioDireto).toEqual(["async function enviarAvisoWhatsApp", "async function enviarAvisoWhatsAppAdministracao"]);

  // send-text só no envio central e no botão "Testar notificação" do próprio usuário.
  const comSendText = funcoes.filter((trecho) => trecho.includes("/send-text")).map((trecho) => trecho.split("\n")[0]);
  expect(comSendText).toEqual([
    'app.post("/teste/notif-whatsapp", authMiddleware, async (c) => {',
    "async function enviarTextoZapi(telefone: string, mensagem: string): Promise<boolean> {",
  ]);

  // Cada chave usada no index.ts existe no catálogo.
  const chavesUsadas = [...fonte.matchAll(/enviarAvisoWhatsApp(?:Administracao)?\("([a-z_]+)"/g)].map((m) => m[1]);
  expect(chavesUsadas.length).toBeGreaterThan(5);
  for (const chave of chavesUsadas) expect(avisoWhatsAppPorChave(chave)).not.toBeNull();
});
