# Nome no bot WhatsApp

Use `PERGUNTA: Com quem falo? [CAPTURAR:nome]` e, depois, `MSG: Prazer, [nome]!`.
O marcador de captura não é enviado ao cliente. A captura precisa ser explícita:
perguntas antigas não são interpretadas automaticamente como pedidos de nome.
Também é aceito `capturar_variavel: "nome"` em passos JSON; para o editor textual,
prefira o marcador, que sobrevive ao ciclo de abrir e salvar um roteiro.

O backend cria `whatsapp_conversas.variaveis` (JSONB, padrão `{}`) na inicialização.
A resposta validada é persistida antes de avançar e atualiza `leads.nome` somente
quando o lead está vinculado à conversa e pertence ao mesmo usuário. O banco
verifica também status, passo e roteiro antes de salvar; a operação usa uma única
instrução SQL. Não busca outro lead por telefone para atualizar o nome.
Áudio, resposta vazia e valores inválidos pedem novamente o nome sem avançar.
A validação é sintática, não confirma a identidade da pessoa.

As mensagens e o histórico usam o mesmo texto renderizado. Sem nome capturado,
`[nome]` vira `você`. Outros marcadores permanecem intactos: idade, cidade e email
ainda não são capturados, embora a coluna JSONB permita essa expansão.
Não há captura retroativa de respostas antigas. Conversas legadas sem roteiro_id
mantêm a progressão sem tentar atribuir sua resposta ao campo nome.

## Ativação do roteiro DIHOR

1. Publicar o backend com a migração e o módulo `whatsapp-bot-variaveis.ts`.
2. Na conta correta do Marcos, criar um NOVO roteiro com o conteúdo de
   `roteiros/dihor-suplementos.txt`, nome `DIHOR Suplementos — nome e perguntas`,
   associado ao nicho Suplementos. Conferir o conteúdo antes de ativar.
3. Ativar esse roteiro pelo fluxo existente da plataforma. Isso desativa o anterior
   apenas no mesmo nicho; Planos de Saúde permanece independente.
4. Não substituir os passos do roteiro ativo no mesmo ID: como o novo texto tem
   mais perguntas, isso mudaria o significado de passo_atual de conversas abertas.
   Ao usar um ID novo, mantém-se a política existente: conversas pouco avançadas
   reiniciam; conversas avançadas são encaminhadas ao humano; humanas ficam humanas.
5. Validar com um contato de teste: nome, quatro perguntas separadas e transferência
   após responder à pergunta final. Conferir variaveis.nome, leads.nome e logs.

Para reverter o roteiro, reativar o anterior pelo painel. A coluna JSONB pode ser
mantida num rollback de código, preservando os nomes já capturados.

## Validação

`bun test` executa os testes existentes e os novos testes da função real do motor
com banco e envio substituídos por simuladores. Isso cobre progressão, captura,
renderização, troca de roteiro e handoff, sem enviar WhatsApp real.
Não equivale a teste integrado com PostgreSQL e Meta em produção.
