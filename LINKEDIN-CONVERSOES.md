# LinkedIn: leads qualificados de volta ao anúncio (Conversions API)

Objetivo: quando o CRM marca um lead como **qualificado** ("quente") ou **fechado**, a plataforma avisa o LinkedIn.
Com a meta de otimização **Leads qualificados** (`MAX_QUALIFIED_LEAD`), o LinkedIn passa a usar esse sinal para
entregar anúncios a perfis parecidos com os leads bons.

**Tudo nasce desligado.** Sem as variáveis abaixo, nenhuma chamada nova é feita e a criação de campanha
continua exatamente como antes.

## Variáveis de ambiente (Railway)

| Variável | Efeito |
| --- | --- |
| `LINKEDIN_CONVERSIONS_ENABLED=true` | Pede o escopo `rw_conversions` no login do LinkedIn, libera `POST /linkedin/conversoes/configurar` e o envio dos eventos de conversão. |
| `LINKEDIN_QUALIFIED_LEAD_OPTIMIZATION=true` | Campanhas **novas** de lead gen passam a usar `MAX_QUALIFIED_LEAD` (lance automático). Só vale se a chave acima também estiver ligada **e** a regra de conversão já existir. |

> **Nunca ligue `LINKEDIN_CONVERSIONS_ENABLED` antes de o LinkedIn aprovar o escopo `rw_conversions` para o app.**
> Pedir um escopo não aprovado faz o LinkedIn recusar o login inteiro (Campaign Manager, campanhas, tudo).

## Ordem de ativação

1. Portal do desenvolvedor do LinkedIn (app 264765153): conferir se `rw_conversions` está disponível/aprovado. Se não, pedir ao suporte.
2. Railway: `LINKEDIN_CONVERSIONS_ENABLED=true` e redeploy.
3. Na plataforma: **reconectar o LinkedIn Ads** (o token antigo não tem o escopo novo).
4. Chamar `POST /linkedin/conversoes/configurar` (cria ou reaproveita a regra de conversão `QUALIFIED_LEAD` da conta selecionada e guarda o URN). Conferir em `GET /linkedin/status-completo` → `conversoes.regra_lead_qualificado_configurada: true`.
5. **Testar em rascunho:** ligar `LINKEDIN_QUALIFIED_LEAD_OPTIMIZATION=true`, criar uma campanha de lead gen **sem ativar** e conferir no Campaign Manager que o conjunto de anúncios usa "Leads qualificados" e está associado à regra (no Campaign Manager: Ad Account > Measurement > Conversion tracking; na interface em português, a seção de Medição/Conversões).
6. Só depois, com pagamento na conta e autorização explícita, ativar uma campanha de verdade.

## Como funciona

- **Regra:** `POST /conversions` (`type: QUALIFIED_LEAD`, `conversionMethod: CONVERSIONS_API`). O URN fica em `plataforma_conexoes.dados_conta` (`conversion_rule_qualified_urn` + `conversion_rule_qualified_conta_id`). A regra só vale para a conta de anúncios a que pertence: se o usuário trocar de conta, ela é ignorada.
- **Campanha:** com a otimização ligada, `/linkedin/adgroup` cria o conjunto com `optimizationTargetType: MAX_QUALIFIED_LEAD` e `costType: CPM` (sem `unitCost`), marca `linkedin_otimizacao` em `configuracoes_avancadas` e associa a campanha à regra (`PUT /campaignConversions`). Se o LinkedIn recusar o payload otimizado, **cai automaticamente no lance manual de sempre** — a criação nunca falha por causa disso. Se só a associação falhar, a resposta traz `aviso`; `POST /linkedin/conversoes/configurar` refaz a associação.
- **Evento:** `POST /conversionEvents` quando o score do lead vira "quente" (`Qualified Lead`) ou o status vira "fechado" (`Closed Won`, só se houver regra de venda informada em `selecionar-conta`). Identificadores enviados: **e-mail com hash SHA-256** e/ou o **URN da resposta do formulário** (`urn:li:leadGenFormResponse:<lead_id>`, só para lead importado pelo Lead Sync). Não vai nome, telefone nem IP. Exige o recurso de plano `meta_conversion_leads`.

## Limites que vêm do LinkedIn (documentação oficial)

- O evento precisa chegar em até **30 dias** para entrar na otimização (a API recusa mais de 90).
- A otimização tem **duas semanas de aprendizado**; o LinkedIn recomenda **5 ou mais leads qualificados** nesse período.
- Só evento que **casa com um perfil** conta. O e-mail do lead precisa ser o mesmo do perfil do LinkedIn.
- Escolha **uma** fonte de lead qualificado (Conversions API **ou** conexão de CRM do Campaign Manager) para não duplicar.
- Orçamento mínimo de R$ 20/dia (já validado pela plataforma) pode tornar difícil chegar a 5 qualificados em duas semanas.

## Não testado contra o LinkedIn real

Nada disto foi executado contra uma conta real (o escopo `rw_conversions` ainda não está aprovado e a conta de teste não tem pagamento).
Os formatos seguem a documentação oficial e estão cobertos por testes em `linkedin-conversoes.test.ts`.
O primeiro teste real é o passo 5 acima (rascunho, sem ativar).

Documentação: Microsoft Learn → LinkedIn Marketing API → *Conversions API*, *Conversions API Schema*, *Conversions API Use Cases* (caso 5) e *Create and Manage Campaigns* (`optimizationTargetType`).
