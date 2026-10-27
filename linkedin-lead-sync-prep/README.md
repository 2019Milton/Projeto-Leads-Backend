# LinkedIn Lead Sync — normalização fictícia, apenas estudo

**NÃO APLICAR EM PRODUÇÃO.** A auditoria do backend existente revelou que o sistema já tem `processarLeadGenFormResponseLinkedIn`, `sincronizarLinkedInAdsUsuario`, tabela `leads` associada a `usuario_id` e rotas de webhook. A proposta anterior de uma tabela `linkedin_lead_sync_inbox` foi descartada nesta branch por ser duplicação do modelo real.

Este diretório conserva apenas exemplos de normalização simulada, sem dependência da API externa. Eles **não** representam o contrato HTTP oficial do LinkedIn.

A correção do webhook existente está na PR de segurança:
https://github.com/2019Milton/Projeto-Leads-Backend/pull/32

## Testes de normalização (dados fictícios)
`node --test linkedin-lead-sync-prep/normalize.test.mjs`

## Antes de liberar integração real
- Aguardar aprovação de Lead Sync API e permissão `r_marketing_leadgen_automation`.
- Preservar a sincronização de campanhas atual e não alterar campanhas pausadas.
- Revisar índice único e transações contra duplicidade de respostas, por `usuario_id`, conta e resposta.
- Testar contrato da API versão vigente, erros 401/403/429, limites e paginação.
- Validar permissões dos membros e políticas de privacidade para dados pessoais.
- Não habilitar `LINKEDIN_LEAD_SYNC_ENABLED` antes dos testes de homologação.
