# Arquitetura do Distributed Wagering Processor

Este documento descreve o estado implementado na branch de observabilidade. O desafio original e o histórico de decisões permanecem em [.docs/challenge.md](.docs/challenge.md) e [.docs/decisions.md](.docs/decisions.md).

## Visão geral

O sistema recebe transações de wagering por HTTP ou SQS, aplica regras financeiras sobre uma carteira PostgreSQL e produz eventos de integração de forma assíncrona. A consistência financeira, a idempotência e a publicação da intenção de evento são tratadas na mesma transação relacional.

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
- `src/http`: controllers, pipes, health checks e filtros de exceção.
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

## Idempotência e concorrência

Repetições com a mesma chave válida retornam o resultado persistido sem reaplicar o efeito financeiro. Uma mesma chave usada com dados incompatíveis gera conflito de idempotência. No SQS, o Inbox e as chaves persistidas tornam o efeito idempotente mesmo quando a mensagem é redeliverada.

O lock da carteira serializa alterações concorrentes do mesmo agregado. Conflitos ou falhas transitórias de lock não enfraquecem as garantias financeiras: a transação é revertida e pode ser tentada novamente conforme o fluxo responsável.

## Mensageria

O contrato de entrada usa mensagens FIFO com `messageId`, `type`, `occurredAt`, `correlationId` opcional e `data`. O consumer valida tipos e dados antes de invocar o caso de uso.

O caminho de saída é:

```text
financial transaction -> outbox row -> claim/lease -> SQS output FIFO
```

O publisher usa leases para permitir recuperação após interrupção de processo, limita o lote e aplica backoff. Mensagens inválidas são enviadas à DLQ de entrada. Falhas transitórias permanecem disponíveis para redelivery; o redrive automático após o limite configurado é responsabilidade do SQS.

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
- `GET /health/ready` consulta PostgreSQL e SQS e retorna status de indisponibilidade quando uma dependência falha.

Os endpoints são públicos. Readiness não encerra o processo: permite que o ambiente de execução retire a instância do tráfego e tente novamente depois.

## Persistência e migrações

PostgreSQL é a fonte de verdade do estado financeiro e operacional. O schema contém tabelas para carteiras, ledger, transações, idempotência, Inbox, Outbox e pendências de referência, com índices e constraints para os invariantes relevantes.

Migrações são executadas explicitamente por `bun run migration:run`. A aplicação não altera o schema automaticamente durante o boot. O Docker Compose fornece PostgreSQL 16 e volumes nomeados para dados locais.

## Execução local

Docker Compose inicia a aplicação, PostgreSQL e LocalStack. O LocalStack cria a fila FIFO de entrada, a DLQ e a fila FIFO de saída. A aplicação runtime é construída a partir de `dist`; migrações devem ser executadas pelo host com Bun e `DATABASE_URL` configurados.

Parâmetros de polling, batch, leases, retry, TTL e workers são configuráveis por ambiente e possuem defaults no código. A configuração completa de desenvolvimento está em [.env.example](.env.example).

### Testes de integração

O runner de integração exige PostgreSQL e LocalStack reais. Cada execução cria um schema PostgreSQL com `search_path` exclusivo, migrations versionadas e filas FIFO próprias (entrada, DLQ e saída). Ao terminar, remove somente o schema e as filas criados pelo runner; volumes, banco público e filas de desenvolvimento não são tocados. A ausência de `DATABASE_URL`, `TEST_DATABASE_SCHEMA` ou das filas isoladas causa falha explícita. Isso impede que um publisher ou consumer externo compartilhe a Outbox do teste.

## Evolução documentada

As primeiras decisões registradas descreviam uma etapa de fundação em que HTTP e SQS ainda eram propostas. Essas decisões continuam preservadas para explicar o raciocínio histórico; a implementação posterior tornou efetivos os controllers, a mensageria, a Inbox/Outbox, a recuperação e a observabilidade. Quando um registro histórico disser que um componente não existia, ele deve ser lido como o estado daquela etapa, não como a descrição atual.

As limitações atuais são: ausência de autenticação/autorização, métricas somente em memória, ausência de dashboards e observação direta do redrive automático da DLQ. Nenhuma dessas limitações altera a atomicidade financeira ou a idempotência persistida.
