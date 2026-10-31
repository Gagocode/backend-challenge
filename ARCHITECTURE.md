# Arquitetura do Distributed Wagering Processor

Este documento descreve o estado implementado nesta entrega. O desafio original e o histórico de decisões permanecem em [.docs/challenge.md](.docs/challenge.md) e [.docs/decisions.md](.docs/decisions.md).

## Visão geral

O sistema recebe transações de wagering por HTTP ou SQS, aplica regras financeiras sobre uma carteira PostgreSQL e produz eventos de integração de forma assíncrona. A consistência financeira, a idempotência e a persistência da intenção de evento são tratadas na transação relacional. O envio efetivo à SQS ocorre depois do commit, pelo publisher da Outbox; envio e commit não são uma operação atômica única.

```text
HTTP / SQS de entrada
          |
          v
Controllers / Consumer
          |
          v
Casos de uso financeiros
          |
          v
FinancialUnitOfWork
   |       |        |        |
wallet  ledger  idempotency inbox/outbox
          |
          v
   PostgreSQL transaction
          |
          v
Outbox Publisher -> SQS de saída

PendingReferenceWorker -> casos de uso financeiros
```

## Componentes implementados

| Componente | Responsabilidade |
| --- | --- |
| Controllers HTTP | Validação de entrada, headers, códigos HTTP e correlação. |
| Casos de uso | Criação de carteira, transação, consulta, ledger e reconciliação. |
| Domínio financeiro | Money em centavos, Wallet, WagerTransaction e regras por tipo de operação. |
| FinancialUnitOfWork | Atomicidade entre carteira, ledger, idempotência, Inbox e Outbox. |
| Repositórios PostgreSQL | Persistência de carteiras, transações, ledger, idempotência, Inbox, Outbox e pendências. |
| OutboxPublisher | Claim com lease, publicação SQS, retry e backoff. |
| SQS consumer | Recebimento, validação, processamento e ACK após commit. |
| PendingReferenceWorker | Retentativa de referências pendentes com lease, backoff e TTL. |
| Health checks | Liveness independente e readiness de PostgreSQL/SQS. |
| Observabilidade | Logs JSON estruturados e métricas Prometheus em memória. |

## Organização do código

- `src/domain`: entidades, value objects e regras puras do domínio.
- `src/application`: casos de uso, portas e DTOs internos.
- `src/persistence`: entidades TypeORM, repositórios e unidade de trabalho.
- `src/messaging`: clientes SQS, publisher, consumer e workers.
- `src/http`: controllers financeiros, pipes e filtros de exceção.
- `src/health.controller.ts` e `src/readiness.controller.ts`: endpoints de liveness e readiness.
- `src/observability`: logger estruturado, serviço de métricas e controller `/metrics`.
- `src/database/migrations`: evolução do schema PostgreSQL.

## Fluxo financeiro

1. O controller ou consumer valida o envelope e cria/propaga um `correlationId` validado.
2. O caso de uso identifica a transação por idempotência e pelas chaves externas do provedor.
3. A `FinancialUnitOfWork` abre uma transação PostgreSQL.
4. A carteira é bloqueada com lock pessimista de linha.
5. A regra da operação é aplicada; o saldo e o ledger são atualizados quando a operação é aceita.
6. A transação idempotente é registrada, juntamente com Inbox e Outbox quando aplicável.
7. O commit confirma a operação. O SQS consumer só remove a mensagem depois dessa confirmação.

Valores monetários são representados como inteiros de centavos e serializados com duas casas decimais. O ledger é imutável. Constraints e índices PostgreSQL apoiam a unicidade e a consistência.

### Sequência transacional e publicação

O processamento financeiro e a escrita da Outbox pertencem à mesma transação PostgreSQL. A publicação SQS é posterior e independente. Para mensagens de entrada, a Inbox também é gravada na transação; o ACK só ocorre após o commit. A entrega é *at-least-once*: se o processo cair depois do commit e antes do ACK, a mensagem pode ser redeliverada, e Inbox/idempotência impedem repetir o efeito financeiro.

```mermaid
sequenceDiagram
    autonumber
    actor Provider as Provedor HTTP
    participant Input as SQS de entrada
    participant Consumer as Consumer SQS
    participant UseCase as Caso de uso
    participant UOW as FinancialUnitOfWork
    participant DB as PostgreSQL
    participant Publisher as OutboxPublisher
    participant Output as SQS de eventos

    alt Entrada HTTP
        Provider->>UseCase: POST transação
        UseCase->>UOW: execute dentro da unidade de trabalho
    else Entrada SQS
        Input->>Consumer: entrega at-least-once
        Consumer->>UOW: executar callback transacional
    end
    UOW->>DB: BEGIN
    opt Mensagem de entrada SQS
        Consumer->>DB: Inbox.receive (claim persistido)
        Consumer->>UseCase: executeWithinTransaction
    end
    UseCase->>DB: validar idempotência/referência e persistir alterações aplicáveis de transação, wallet e ledger
    UseCase->>DB: persistir eventos Outbox no mesmo contexto transacional
    opt Mensagem de entrada SQS
        Consumer->>DB: marcar Inbox processada no mesmo contexto
    end
    alt Resultado de negócio concluído (PROCESSED, PENDING_REFERENCE ou REJECTED)
        UOW->>DB: COMMIT
        Note over DB: Estado financeiro, Inbox (se aplicável) e Outbox ficam confirmados juntos
    else Erro antes do commit
        UOW->>DB: ROLLBACK
        Note over Input,Consumer: Sem ACK; mensagem fica disponível para redelivery
    end
    par Resposta/ACK do fluxo de entrada após commit
        opt Entrada HTTP
            UseCase-->>Provider: resposta com resultado persistido (inclui REJECTED quando aplicável)
        end
        opt Entrada SQS
            Consumer->>Input: DeleteMessage / ACK
        end
    and Publicação assíncrona da Outbox
        loop Polling da Outbox
            Publisher->>DB: claim por lease e leitura de eventos pendentes
            Publisher->>Output: SendMessage após o commit financeiro
            alt Envio confirmado
                Publisher->>DB: marcar published_at
            else Falha ou processo interrompido
                Note over Publisher,Output: Retry/backoff e lease recuperável; crash após SendMessage pode gerar publicação duplicada
                Publisher->>DB: agendar retry ou deixar lease expirar
            end
        end
    end
```

O ACK SQS de entrada não confirma a publicação dos eventos de saída. Se o publisher cair depois de `SendMessage` e antes de marcar a Outbox como publicada, ele pode publicar novamente após recuperar a lease. Consumidores de eventos de saída devem tolerar duplicatas.

### Estados da transação e operações financeiras

Os estados descrevem o ciclo de vida da transação; os tipos de operação descrevem o efeito financeiro. `PROCESSED`, `REJECTED` e `FAILED` são terminais no domínio.

| Estado | Significado e condição de entrada | Efeito financeiro | Nova tentativa/transição |
| --- | --- | --- | --- |
| `PENDING` | Estado inicial do agregado antes da aplicação das regras; no fluxo atual é transitório enquanto o caso de uso executa. | Ainda não aplicado. | Pode avançar para `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`, conforme a operação. |
| `PENDING_REFERENCE` | `REFUND` ou `ROLLBACK` requer referência externa ainda ausente. | Nenhum saldo ou lançamento é aplicado; a transação e os eventos correspondentes são persistidos. | Worker tenta novamente com lease e backoff. Quando a referência aparece, pode processar ou rejeitar; se continuar ausente na execução do worker após o TTL, é rejeitada com `REFERENCE_NOT_FOUND`. |
| `PROCESSED` | Regras satisfeitas e operação concluída. | Conforme o tipo abaixo. Estado terminal; repetição idempotente retorna o resultado persistido. | Não transiciona para outro estado. |
| `REJECTED` | Regra financeira ou referência inválida; inclui saldo insuficiente, moeda incompatível ou referência expirada/inválida. | Sem alteração de saldo/ledger para a operação rejeitada. Estado terminal e auditável. | Repetir o mesmo payload devolve o resultado persistido; outra tentativa precisa respeitar a unicidade da chave idempotente e da identidade externa. |
| `FAILED` | Estado terminal disponível no modelo para falha permanente auditável. | Não há efeito financeiro a partir desta transição de domínio. | `fail()` não é chamado pelo fluxo operacional atual; falhas transitórias de infraestrutura provocam rollback/redelivery/retry, não marcam a transação como `FAILED`. |

| Operação | Condição e referência | Efeito quando processada | Observação |
| --- | --- | --- | --- |
| `OPENING` | Interna; criada ao abrir wallet com saldo inicial positivo. | Crédito e lançamento `CREDIT` na mesma unidade de trabalho. | Saldo inicial zero não cria transação `OPENING` nem lançamento. Não é aceita na API ou no envelope SQS. |
| `BET` | Débito de aposta. | Débito e lançamento `DEBIT`. | Saldo insuficiente resulta em `REJECTED`; não permite saldo negativo. |
| `WIN` | Crédito de prêmio. Uma referência, se fornecida, deve apontar para `BET` no mesmo contexto; referência não é obrigatória pelo domínio. | Crédito e lançamento `CREDIT`. | O valor não precisa ser igual ao da aposta referenciada. |
| `LOSS` | Registro de perda; não exige referência. | Sem alteração de saldo e sem lançamento de ledger. | Transação pode ser `PROCESSED` sem movimento monetário. |
| `REFUND` | Exige referência a `BET` processada no mesmo contexto e de mesmo valor. | Crédito e lançamento `CREDIT`. | Referência ausente gera `PENDING_REFERENCE`; saldo insuficiente na reversão é rejeição. |
| `ROLLBACK` | Exige referência processada a `BET`, `WIN` ou `REFUND` no mesmo contexto e de mesmo valor. | Inverte a direção de ledger da operação referenciada; pode debitar ou creditar. | Referência ausente gera `PENDING_REFERENCE`; débito que excederia saldo resulta em rejeição. |

As transições e condições acima são implementadas em `src/domain/wager-transaction/wager-transaction.ts` e `src/application/use-cases/process-wager-transaction.use-case.ts`; os testes de domínio e de integração listados na matriz abaixo exercitam os casos principais.

## Idempotência e concorrência

Repetições com a mesma chave válida retornam o resultado persistido sem reaplicar o efeito financeiro. Uma mesma chave usada com dados incompatíveis gera conflito de idempotência. No SQS, o Inbox e as chaves persistidas tornam o efeito idempotente mesmo quando a mensagem é redeliverada.

O lock da carteira serializa alterações concorrentes do mesmo agregado. Conflitos ou falhas transitórias de lock não enfraquecem as garantias financeiras: a transação é revertida e pode ser tentada novamente conforme o fluxo responsável.

## Mensageria

O contrato de entrada usa mensagens FIFO com `messageId`, `type`, `occurredAt`, `correlationId` opcional e `data`. O consumer valida tipos e dados antes de invocar o caso de uso.

Exemplo compatível com `parseWagerTransactionMessage` e `WagerTransactionConsumer`:

```json
{
  "messageId": "msg-8a1f",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-31T14:00:00.000Z",
  "correlationId": "request-9f3a",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "bet-123",
    "idempotencyKey": "provider-a:bet-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

`messageId` identifica a mensagem para Inbox; `idempotencyKey` identifica a operação financeira; `correlationId` é opcional. `occurredAt` deve ser uma data válida. O envelope aceita `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`, não `OPENING`. Os campos monetários são strings e a referência externa usa `referenceExternalTransactionId` quando necessária.

O caminho de saída é:

```text
financial transaction -> outbox row -> claim/lease -> SQS output FIFO
```

O publisher usa leases para permitir recuperação após interrupção de processo, limita o lote e aplica backoff. Mensagens inválidas são enviadas à DLQ de entrada. Falhas transitórias permanecem disponíveis para redelivery; o redrive automático após o limite configurado é responsabilidade do SQS.

A `wager-integration-events.fifo` não é consumida pelo consumer financeiro interno. Ela contém eventos da Outbox para consumidores externos ou uma futura camada de fan-out; portanto, a topologia implementada não é uma cadeia Outbox → consumer financeiro. Os testes usam LocalStack 3.8.1, não AWS em produção.

Quando uma operação depende de outra transação ainda ausente, ela fica em `PENDING_REFERENCE`. O worker retoma a pendência até o TTL configurado; expirado esse prazo, a operação não é aplicada silenciosamente.

## Observabilidade e correlação

O logger emite uma linha JSON por evento operacional relevante e usa uma lista controlada de campos. Os campos de correlação são incluídos quando disponíveis: `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `eventId`, `consumerName` e `attempt`. Payloads completos, dinheiro, credenciais, tokens e mensagens de erro potencialmente sensíveis não são registrados.

O `correlationId` é validado na entrada. Um valor externo inválido é substituído por um identificador local; o valor não é aceito cegamente. A correlação segue HTTP -> caso de uso -> Outbox -> publisher -> SQS -> consumer -> Inbox e também o fluxo do worker de referências.

O endpoint `GET /metrics` expõe:

- `wager_transactions_total{status}`
- `wager_duplicates_total{source}`
- `wager_retries_total{component,reason}`
- `wager_dlq_messages_total{reason}`
- `wager_lock_conflicts_total{component}`
- `wager_outbox_lag_seconds`
- `wager_processing_duration_seconds{source,status}`
- `wager_reconciliation_divergences_total`

As unidades são contagens, exceto `wager_outbox_lag_seconds` e `wager_processing_duration_seconds`, que são segundos. Os labels têm cardinalidade controlada e não contêm IDs de negócio. O estado atual não usa OpenTelemetry, Prometheus server ou dashboards.

## Health checks

- `GET /health/live` retorna sucesso se o processo está vivo e não consulta dependências.
- `GET /health/ready` consulta PostgreSQL e SQS e retorna status de indisponibilidade quando uma dependência falha. Para SQS, a sonda exige as filas de entrada, DLQ e saída como FIFO, `ContentBasedDeduplication=false` e valida a `RedrivePolicy` da entrada para a DLQ com cinco recebimentos.

Os endpoints são públicos. Readiness não encerra o processo: permite que o ambiente de execução retire a instância do tráfego e tente novamente depois.

## Autenticação

Autenticação e autorização não foram implementadas, conforme a opção aceita pela seção 2 do desafio e a limitação de escopo desta entrega. Os endpoints HTTP são públicos e a fila é tratada como canal interno confiável; ainda assim, `providerId`, identidade da wallet/player, moeda e demais campos da mensagem são validados. Uma integração futura deve introduzir um guard/port de identidade do provedor antes dos controllers, sem mover regras financeiras para essa camada.

## Persistência e migrações

PostgreSQL é a fonte de verdade do estado financeiro e operacional. O schema contém tabelas para carteiras, ledger, transações, idempotência, Inbox, Outbox e pendências de referência, com índices e constraints para os invariantes relevantes.

Migrações são executadas explicitamente por `bun run migration:run`. A aplicação não altera o schema automaticamente durante o boot. A migration de associações financeiras cria FKs compostas como `NOT VALID` e tenta validá-las na mesma execução; portanto, um schema legado com violações precisa de saneamento e decisão operacional antes de aplicar essa migration. O Docker Compose fornece PostgreSQL 16 e volumes nomeados para dados locais.

## Execução local

Docker Compose inicia a aplicação, PostgreSQL e LocalStack. O LocalStack cria a fila FIFO de entrada, a DLQ e a fila FIFO de saída. A aplicação runtime é construída a partir de `dist`; migrações devem ser executadas pelo host com Bun e `DATABASE_URL` configurados.

O bootstrap em `docker/localstack/init/ready.d/10-create-sqs.sh` é executado no estágio `READY`, usa `/bin/sh` em formato LF e atualiza somente atributos configuráveis quando as filas já existem. A fila principal recebe a `RedrivePolicy` para a DLQ e a DLQ restringe o redrive à fila principal; nenhum recurso é removido durante reinícios.

Parâmetros de polling, batch, leases, retry, TTL e workers são configuráveis por ambiente e possuem defaults no código. A configuração completa de desenvolvimento está em [.env.example](.env.example).

### Testes de integração

O runner de integração exige PostgreSQL e LocalStack reais. Cada execução cria um schema PostgreSQL com `search_path` exclusivo, passa esse schema por `TEST_DATABASE_SCHEMA`, aplica migrations versionadas e cria filas FIFO próprias (entrada, DLQ e saída). Ao terminar, remove somente o schema e as filas criados pelo runner; volumes, banco público e filas de desenvolvimento não são tocados. A ausência de `DATABASE_URL` ou das dependências de SQS causa falha explícita. Isso impede que um publisher ou consumer externo compartilhe a Outbox do teste.

## Rastreabilidade entre requisitos, implementação e testes

Esta matriz aponta evidências navegáveis. Os testes indicados são evidência de comportamento em ambiente de teste, não uma afirmação de validação contra AWS em produção.

| Requisito | Implementação | Evidência de teste |
| --- | --- | --- |
| Precisão monetária | `src/domain/money/money.ts`; mapeamento em `src/persistence/mappers/financial.mappers.ts` | `test/money.test.ts`; `test/financial-persistence.integration.test.ts` |
| Integridade financeira e ledger imutável | `src/domain/wallet/wallet.ts`; `src/domain/wallet/wallet-ledger-entry.ts`; migrations `src/database/migrations/1710000001000-CreateFinancialPersistence.ts` e `1710000004000-StrengthenFinancialAssociations.ts` | `test/financial-persistence.integration.test.ts`; `test/financial-use-cases.integration.test.ts` |
| Concorrência por wallet | `src/persistence/repositories/financial-repositories.ts`; `src/application/use-cases/process-wager-transaction.use-case.ts` | `test/financial-persistence.integration.test.ts`; cenários A, B e C em `test/distributed-recovery.integration.test.ts` |
| Idempotência HTTP e SQS | `src/application/messaging/payload-hash.ts`; repositórios financeiros; `src/messaging/sqs/wager-transaction.consumer.ts` | `test/http.e2e.test.ts`; `test/financial-use-cases.integration.test.ts`; `test/sqs.regression.integration.test.ts` |
| Inbox/Outbox transacionais e claims concorrentes | `src/persistence/unit-of-work/typeorm-financial-unit-of-work.ts`; `src/persistence/repositories/messaging-repositories.ts`; `src/application/messaging/enqueue-financial-events.ts` | `test/messaging.integration.test.ts` (rollback financeiro/Outbox, Inbox concorrente, claims e leases) |
| SQS, redelivery e ACK após commit | `src/messaging/sqs/wager-transaction.consumer.ts`; `src/messaging/sqs/sqs-client.ts` | `test/sqs.regression.integration.test.ts`; cenários D e crash após commit em `test/distributed-recovery.integration.test.ts` |
| Retry e DLQ | `src/messaging/sqs/wager-transaction.consumer.ts`; `src/messaging/sqs/outbox.publisher.ts`; `docker/localstack/init/ready.d/10-create-sqs.sh` | Cenários de retry/redrive e recuperação em `test/distributed-recovery.integration.test.ts`; `test/sqs.regression.integration.test.ts` |
| Referências pendentes e expiração | `src/messaging/pending-reference.worker.ts`; `src/application/use-cases/process-wager-transaction.use-case.ts` | `test/financial-use-cases.integration.test.ts`; `test/messaging.integration.test.ts`; cenário de REFUND fora de ordem em `test/distributed-recovery.integration.test.ts` |
| Reconciliação | `src/application/use-cases/reconcile-wallet.use-case.ts`; `src/http/wallets.controller.ts` | `test/http.e2e.test.ts`; reconciliação sob concorrência em `test/distributed-recovery.integration.test.ts` |
| Observabilidade e health checks | `src/observability/metrics.service.ts`; `src/observability/structured-logger.ts`; `src/health.controller.ts`; `src/readiness.controller.ts` | `test/observability.test.ts`; `test/health.controller.test.ts`; `test/readiness.controller.test.ts` |
| Recuperação após falhas | Consumer, publisher, leases persistentes e unidade de trabalho | `test/messaging.integration.test.ts` (rollback e redelivery); cenários de crash/restart em `test/distributed-recovery.integration.test.ts` |

## Evolução documentada

As primeiras decisões registradas descreviam uma etapa de fundação em que HTTP e SQS ainda eram propostas. Essas decisões continuam preservadas para explicar o raciocínio histórico; a implementação posterior tornou efetivos os controllers, a mensageria, a Inbox/Outbox, a recuperação e a observabilidade. Quando um registro histórico disser que um componente não existia, ele deve ser lido como o estado daquela etapa, não como a descrição atual.

As limitações atuais são: ausência de autenticação/autorização, métricas somente em memória, ausência de dashboards e observação direta do redrive automático da DLQ. Nenhuma dessas limitações altera a atomicidade financeira ou a idempotência persistida.
