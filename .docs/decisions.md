# Registro de decisões arquiteturais

## Convenção

Status possíveis: **proposta**, **aprovada** e **substituída**. O [README](../README.md) é a fonte dos requisitos; [challenge.md](challenge.md) é sua cópia fiel.

## Estado atual e evolução das decisões

As ADRs abaixo preservam o histórico das etapas em que foram aprovadas. Algumas consequências descrevem limitações que existiam naquele momento e foram superadas por decisões posteriores. Em particular:

- A ADR-003 continua válida para TypeORM, migrações explícitas e separação entre liveness e readiness; sua referência à readiness somente PostgreSQL era uma limitação da etapa inicial.
- A ADR-011 continua válida para os contratos HTTP e a reconciliação; a limitação de SQS foi superada pelas ADRs-012, 013, 014 e 015.
- A ADR-012 foi expandida pela ADR-014 para separar a fila de entrada da fila de eventos de integração.
- A ADR-016 registra a observabilidade atualmente implementada: logs estruturados, métricas em memória, correlação validada e health checks sem infraestrutura adicional.

Nenhuma decisão histórica é removida. Quando uma ADR antiga disser que um componente ainda não existia, isso representa o estado daquela etapa, não o estado atual do código.

## ADR-001 — README oficial como fonte de verdade

- **ID:** ADR-001
- **Status:** aprovada
- **Data:** 2026-10-29
- **Contexto e problema:** A organização documental não pode modificar o escopo oficial.
- **Alternativas consideradas:** substituir o README; resumir o desafio; manter o README e criar cópia fiel.
- **Decisão:** preservar o README integralmente e criar `challenge.md`.
- **Justificativa:** mantém a referência oficial verificável.
- **Consequências e trade-offs:** qualquer mudança futura do escopo exige sincronização verificável da cópia.

## ADR-002 — Separar requisitos, propostas e implementação

- **ID:** ADR-002
- **Status:** aprovada
- **Data:** 2026-10-29
- **Contexto e problema:** O desafio deixa escolhas relevantes ao candidato.
- **Alternativas consideradas:** antecipar decisões; registrar só requisitos; separar categorias.
- **Decisão:** `ARCHITECTURE.md` separará requisitos, propostas, decisões aprovadas e validações.
- **Justificativa:** evita que hipótese seja apresentada como fato.
- **Consequências e trade-offs:** lacunas deliberadas devem ser resolvidas antes da implementação.

## ADR-003 — TypeORM, migrações explícitas e readiness

- **ID:** ADR-003
- **Status:** aprovada
- **Data:** 2026-10-29
- **Contexto e problema:** A aplicação precisa conectar-se ao PostgreSQL sem permitir que o ORM altere o schema implicitamente, e o mecanismo de evolução do banco precisa ser executável e reversível com Bun.
- **Alternativas consideradas:** Prisma (fora das restrições); `synchronize: true`; TypeORM com CLI externa; TypeORM com `DataSource` compartilhado e scripts Bun; readiness misturado ao liveness.
- **Decisão:** usar TypeORM com `@nestjs/typeorm` e driver `pg`, carregar a conexão por `DATABASE_URL`, manter `synchronize: false` e `migrationsRun: false`, e executar migrações por um `DataSource` compartilhado através dos comandos `migration:create`, `migration:run` e `migration:revert`. O liveness continuará sem dependências; `GET /health/ready` fará um `SELECT 1` no PostgreSQL e responderá `503` quando a dependência estiver indisponível.
- **Justificativa:** atende à stack permitida, mantém o schema sob controle versionado e permite validar o ciclo de vida sem antecipar entidades financeiras.
- **Consequências e trade-offs:** o deploy precisa executar `migration:run` explicitamente; falhas de inicialização da conexão encerram a aplicação com erro estruturado; a primeira migração contém somente uma tabela técnica `migration_probe`, que deverá ser removida ou substituída quando o schema de domínio for definido.

## ADR-004 — Representação exata de Money

- **ID:** ADR-004
- **Status:** aprovada
- **Data:** 2026-10-29
- **Contexto e problema:** Valores monetários não podem depender de `number`, `float`, `double` ou arredondamentos implícitos, pois o objeto será usado nas invariantes financeiras futuras.
- **Alternativas consideradas:** `number`; strings recalculadas com aritmética decimal manual; biblioteca decimal adicional; `bigint` armazenando centavos.
- **Decisão:** `Money` será um objeto de valor independente, com `bigint` privado representando centavos e moeda como código ISO-4217 de três letras maiúsculas. Entradas são strings decimais não negativas com no máximo duas casas; a serialização sempre produz duas casas. Operações podem produzir resultados negativos internamente, mas contratos de entrada rejeitam valores negativos.
- **Justificativa:** `bigint` fornece precisão exata e escala fixa sem dependências externas ou conversões binárias; a validação explícita rejeita notação científica, valores malformados e precisão não suportada.
- **Consequências e trade-offs:** o valor monetário não pode ser serializado diretamente como `bigint`; `toString` e `toJSON` são os formatos explícitos. A escala está limitada a duas casas nesta etapa, conforme o contrato do desafio.

## Decisões pendentes

| ID | Título | Status | Contexto, alternativas e decisão pendente |
|---|---|---|---|
| PEND-001 | Concorrência por carteira | proposta | Escolher lock pessimista, otimista com retry limitado, update condicionado ou combinação. |
| PEND-002 | Idempotência e hash | proposta | Definir campos, JSON canônico, algoritmo, constraints e replay/conflito. |
| PEND-003 | Persistência e Money | proposta | Definir ORM permitido, colunas, precisão/escala e reidratação. |
| PEND-004 | Síncrono versus assíncrono | proposta | Definir semântica HTTP, casos de uso compartilhados e workers. |
| PEND-005 | Retry SQS | proposta | Definir limite, backoff, visibility timeout, DLQ e shutdown. |
| PEND-006 | Referências ausentes | proposta | Definir agenda, TTL/limite, rejeição e failure code. |
| PEND-007 | Outbox concorrente | proposta | Definir claim/lock, lote, retry e recuperação. |
| PEND-008 | Autenticação | proposta | Definir IdP externo ou extensão no-op documentada. |
| PEND-009 | OpenAPI | proposta | Definir geração, validação e disponibilização. |

Cada item deverá registrar contexto/problema, alternativas, decisão, justificativa, consequências/trade-offs e data antes de receber status **aprovada**.

## ADR-008 — Persistência financeira PostgreSQL

- **ID:** ADR-008
- **Status:** aprovada
- **Data:** 2026-10-30
- **Contexto e problema:** Wallet, transações e ledger precisam ser persistidos com precisão decimal, invariantes reforçadas pelo banco e domínio independente do TypeORM.
- **Alternativas consideradas:** entidades TypeORM no domínio; valores monetários em `double precision`; tabelas sem constraints e validação somente em aplicação.
- **Decisão:** usar entidades TypeORM isoladas em `src/persistence`, mappers explícitos e contratos na camada de aplicação. Valores monetários serão `NUMERIC(20,2)` lidos como `string`, convertidos em `Money` pelas factories `rehydrate` dos agregados. A idempotência será única por `(provider_id, idempotency_key)` e a identificação externa por `(provider_id, external_transaction_id)`.
- **Justificativa:** preserva a exatidão decimal e evita acoplamento do domínio, enquanto constraints, FK, índices e trigger de ledger protegem invariantes mesmo fora da aplicação.
- **Consequências e trade-offs:** o limite de `NUMERIC(20,2)` é explícito; `OPENING` continua sendo responsabilidade de um caso de uso futuro. A tabela de ledger rejeita `UPDATE`/`DELETE` por trigger e só aceita inserções aritmeticamente válidas.

## ADR-009 — Concorrência por wallet

- **ID:** ADR-009
- **Status:** aprovada
- **Data:** 2026-10-30
- **Contexto e problema:** duas instâncias podem alterar a mesma carteira simultaneamente, e a unidade de concorrência exigida é `walletId`.
- **Decisão:** os repositórios oferecem leitura com `pessimistic_write`; o caso de uso futuro deve abrir uma transação SQL, bloquear apenas a linha da wallet, aplicar o movimento no agregado e gravar wallet, transação e ledger antes do commit.
- **Justificativa:** o lock é distribuído pelo PostgreSQL, funciona entre processos e mantém wallets diferentes em paralelo; não há lock global em memória.
- **Consequências e trade-offs:** o fluxo financeiro completo e retries de deadlock/timeout permanecem fora desta etapa; os chamadores devem usar o método `forUpdate` somente dentro de uma transação ativa.

## ADR-010 — Unidade de trabalho e idempotência dos casos de uso

- **ID:** ADR-010
- **Status:** aprovada
- **Data:** 2026-10-30
- **Contexto e problema:** A Etapa 10 precisa coordenar wallet, transação e ledger atomicamente, inclusive quando duas instâncias recebem a mesma operação ou quando uma referência chega fora de ordem.
- **Decisão:** introduzir a porta `FinancialUnitOfWork` na aplicação e a implementação `TypeOrmFinancialUnitOfWork`, baseada em `DataSource.transaction`. O caso de uso bloqueia a wallet com `pessimistic_write`, consulta novamente a idempotência após o lock e trata uma violação de unicidade pós-commit tentado relendo a chave persistida. `PENDING_REFERENCE` é reprocessada pela mesma operação quando a referência aparece.
- **Justificativa:** mantém TypeORM na infraestrutura, cobre concorrência entre processos e deixa o PostgreSQL como autoridade final de unicidade; falhas inesperadas não são repetidas automaticamente nem deixam alterações parciais.
- **Consequências e trade-offs:** conflito de transação externa e payload divergente são erros de aplicação; retry de deadlock/timeout e integração HTTP/SQS ficam para etapas posteriores. `WIN` sem referência disponível é rejeitado quando uma referência foi informada, pois o domínio não oferece `PENDING_REFERENCE` para WIN.

## ADR-005 — Transições explícitas de Wallet e ledger

- **ID:** ADR-005
- **Status:** aprovada
- **Data:** 2026-10-30
- **Contexto e problema:** A alteração do saldo e o lançamento correspondente precisam ser produzidos pela mesma regra de domínio, sem simular atomicidade por cache ou estado paralelo em memória.
- **Alternativas consideradas:** alterar a Wallet e deixar o caso de uso montar o ledger; retornar somente o novo saldo; receber uma especificação de movimento e retornar o lançamento criado.
- **Decisão:** `Wallet.debit` e `Wallet.credit` recebem `{ id, transactionId, money, at? }`, validam moeda, sinal e saldo, criam e retornam um `WalletLedgerEntry`, e somente então aplicam a nova versão do saldo. O caso de uso/persistência posterior gravará os dois resultados na mesma transação SQL.
- **Justificativa:** a API torna explícita a correspondência entre transição e lançamento e impede que o chamador construa um ledger divergente. A Wallet continua sendo o aggregate root; o ledger não possui operações de alteração.
- **Consequências e trade-offs:** a criação de uma wallet não fabrica um lançamento sem `transactionId`; o caso de uso de abertura deverá criar a transação interna `OPENING` e seu ledger na transação SQL prevista pelo desafio. Movimentos de valor zero podem gerar lançamento matematicamente balanceado, mas não incrementam `version`.

## ADR-006 — Reidratação e imutabilidade temporal

- **ID:** ADR-006
- **Status:** aprovada
- **Data:** 2026-10-30
- **Contexto e problema:** Wallet e ledger precisam reconstruir estado persistido sem expor mutabilidade acidental por objetos `Date`.
- **Alternativas consideradas:** expor `Date` diretamente; converter datas para strings no domínio; armazenar datas internamente e retornar cópias.
- **Decisão:** factories `rehydrate` recebem o estado já persistido; não executam transições nem recalculam lançamentos. Datas são copiadas na entrada e na leitura. A `Wallet` ainda preserva saldo não negativo e moeda coerente, enquanto `WalletLedgerEntry.rehydrate` permite que `isBalanced()` revele inconsistência histórica sem alterá-la.
- **Justificativa:** mantém a reidratação fiel ao estado persistido e evita que consumidores mutem o agregado/registro por referência.
- **Consequências e trade-offs:** inconsistências persistidas não são “corrigidas” pelo domínio; reconciliação e constraints de banco serão responsabilidades posteriores.

## ADR-007 — WagerTransaction e referências fora de ordem

- **ID:** ADR-007
- **Status:** aprovada
- **Data:** 2026-10-30
- **Contexto e problema:** Transações de aposta podem chegar duplicadas ou fora de ordem, e a entidade precisa preservar estados terminais, referências externas e regras de reversão sem consultar persistência.
- **Alternativas consideradas:** resolver referências dentro da entidade; aceitar qualquer transição e validar no caso de uso; modelar estados explícitos e validar uma referência já carregada por método de domínio.
- **Decisão:** `WagerTransaction.create` cria sempre em `PENDING`; `markPendingReference` permite `PENDING → PENDING_REFERENCE`; `markProcessed`, `reject` e `fail` permitem concluir estados não terminais. `PROCESSED`, `REJECTED` e `FAILED` são terminais. `assertValidReference` valida contexto, moeda, tipo, status e igualdade de valor das reversões quando a transação referenciada estiver disponível.
- **Justificativa:** a entidade representa corretamente a entrega fora de ordem sem cache ou repositório em memória. A referência é identificada pelo `referenceExternalTransactionId`; sua resolução e a prevenção de duas reversões ficam para o caso de uso e constraints persistentes.
- **Taxonomia de falhas:** `INSUFFICIENT_BALANCE`, `REVERSAL_INSUFFICIENT_BALANCE`, `INVALID_REFERENCE`, `REFERENCE_NOT_FOUND`, `CURRENCY_MISMATCH` e `DUPLICATE_REVERSAL` são códigos estáveis. O código de saldo insuficiente em reversão é distinto do código de aposta sem saldo.
- **Consequências e trade-offs:** `WIN` pode referenciar uma `BET` da mesma rodada sem exigir igualdade de valor; `REFUND` exige `BET` processada e `ROLLBACK` aceita `BET`, `WIN` ou `REFUND` processadas, sempre com o mesmo valor. `OPENING` existe apenas para uso interno e não deve ser aceito por API/fila.
## ADR-011 — Contratos HTTP e reconciliação

- **Status:** aprovada — 2026-10-30.
- **Decisão:** controllers usam DTOs HTTP estritos e serializadores próprios; regras financeiras permanecem nos casos de uso. A paginação do ledger é cursor-based por `(createdAt,id)`, e a reconciliação é somente leitura, com divergências logadas.
- **Justificativa:** evita acoplamento com TypeORM, mantém respostas determinísticas e não mascara inconsistências financeiras.
- **Trade-offs:** a readiness reporta somente PostgreSQL enquanto o cliente SQS não existe; a integração SQS será adicionada em etapa posterior.
- **ADR-012 — Transactional Outbox e Inbox persistentes**

  - **Status:** aprovada
  - **Data:** 2026-10-30
  - **Decisão:** criar `outbox_messages` e `inbox_messages` em migration reversível. O caso de uso grava eventos na mesma transação que wallet, transação e ledger. O publisher usa claim com `FOR UPDATE SKIP LOCKED`, lease recuperável e at-least-once; o consumer usa unicidade `(consumer_name,message_id)`, executa o caso de uso na mesma transação e confirma SQS somente após commit.
  - **Retry/DLQ:** publish usa backoff exponencial persistido; erro transitório de consumer deixa a mensagem para redelivery; mensagem inválida vai diretamente à DLQ; rejeição de negócio é terminal com ACK. A FIFO usa `VisibilityTimeout=30` e `maxReceiveCount=5`.
  - **Limitação histórica:** a primeira implementação não tinha destino de saída definido pelo README e publicou temporariamente envelopes na FIFO de entrada. A auditoria demonstrou que essa alternativa permitia perda silenciosa; ela foi corrigida e substituída pela ADR-014, que separa a FIFO de integração.

- **ADR-013 — Eventos de integração versionados**

  - **Status:** aprovada
  - **Data:** 2026-10-30
  - **Decisão:** usar classe abstrata `IntegrationEvent` e uma classe concreta por evento, com `eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId` opcional, `occurredAt`, `version` e `data`. Payloads são DTOs estáveis; `Money` é serializado como `MoneyProps`.
  - **Consequências:** o evento de processamento inclui `LOSS`; saldo alterado só produz `WalletBalanceChanged` quando o snapshot realmente muda. Replays idempotentes não criam novos eventos.

## ADR-014 — Separação da entrada SQS e dos eventos de integração

- **Status:** aprovada
- **Data:** 2026-10-31
- **Contexto e problema:** a auditoria demonstrou que publicar eventos de integração na FIFO de entrada permitia que o consumer financeiro os removesse sem processá-los, causando perda silenciosa e misturando contratos incompatíveis.
- **Decisão:** preservar `wager-transactions.fifo` exclusivamente para `WagerTransactionRequested`, manter `wager-transactions-dlq.fifo` como sua DLQ e criar `wager-integration-events.fifo` como destino dos envelopes da Outbox. O README não prescreve uma fila de saída; esta é uma extensão compatível e explicitamente documentada. Não haverá consumer financeiro da fila de saída.
- **Justificativa:** separa produtores e consumidores por contrato, impede ciclos e mantém a fila de entrada definida pelo desafio. A consistência financeira continua no PostgreSQL, não na FIFO.
- **Consequências e trade-offs:** consumidores externos devem assinar/ler a fila de saída ou uma camada posterior de fan-out, que está fora do escopo. Envelopes de integração encontrados na fila de entrada são roteados para a DLQ, nunca ACKados silenciosamente.

## ADR-015 — Hash sem metadados de transporte e leases persistentes

- **Status:** aprovada
- **Data:** 2026-10-31
- **Decisão:** HTTP e SQS usam a mesma canonização dos campos financeiros; `messageId`, timestamp de transporte e outros metadados não participam do hash. A Inbox continua identificada por `(consumer_name,message_id)`. Outbox e `PENDING_REFERENCE` usam tokens e leases persistidos no PostgreSQL, com renovação periódica e backoff persistido.
- **Justificativa:** preserva replay idempotente entre redeliveries/envelopes distintos sem relaxar conflito de payload, e permite exclusividade/recuperação entre múltiplas instâncias.
- **Consequências:** publicação continua at-least-once; falha depois do envio e antes do commit de `published_at` pode produzir duplicata, que consumidores devem tratar de forma idempotente.
## ADR-016 - Observabilidade operacional sem infraestrutura adicional

- **Status:** aprovada - 2026-10-31.
- **Contexto:** a secao 12 exige logs estruturados, transacoes por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latencia e health separado, mas OpenTelemetry, Prometheus e dashboards sao opcionais.
- **Decisao:** usar `StructuredLogger` com allowlist de campos e `MetricsService` em memoria, expondo `GET /metrics` no formato Prometheus. Nenhum identificador financeiro ou payload sera label; valores monetarios nao serao logados nem medidos.
- **Semantica:** status e contado somente para resultado financeiro novo; replay HTTP e redelivery Inbox processada contam como duplicata, sem repetir efeito. Lag e latencia usam segundos; retry, DLQ, lock e divergencia usam contadores.
- **Correlacao:** IDs externos sao validados por formato; HTTP propaga o ID para o caso de uso e Outbox, e SQS o propaga no envelope, usando `messageId` como fallback. `causationId` identifica a mensagem de origem.
- **Consequencias:** a aplicacao nao depende de exporter ou servidor adicional e continua simples de operar. O endpoint nao oferece retencao nem alertas; redrive automatico do SQS so pode ser observado por ferramentas externas.
