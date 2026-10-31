# Distributed Wagering Processor

Processador distribuído de transações de wagering com garantia de idempotência, consistência financeira e processamento assíncrono. O projeto recebe transações de provedores, aplica a operação na carteira do jogador, registra um ledger imutável e publica eventos de integração por meio de uma Transactional Outbox.

## Objetivo

Implementar o fluxo financeiro de apostas e seus eventos de forma segura sob concorrência, reentrega de mensagens e falhas temporárias de infraestrutura. O estado financeiro é persistido no PostgreSQL; a mensageria utiliza SQS, com LocalStack para desenvolvimento local.

## Principais funcionalidades

- Criação e consulta de carteiras com saldo monetário exato em centavos.
- Ledger imutável e reconciliação do saldo da carteira.
- Operações BET, WIN, LOSS, REFUND e ROLLBACK.
- Idempotência por `Idempotency-Key` e pelas chaves externas do provedor.
- Tratamento de referências ainda não disponíveis com estado `PENDING_REFERENCE`.
- Transactional Outbox e Inbox persistidas na mesma transação financeira.
- Publisher de Outbox com leases, backoff e processamento concorrente.
- Consumer SQS com ACK somente após o commit, redelivery e DLQ.
- Worker de pendências de referência com leases, retry, backoff e TTL.
- Logs JSON estruturados, métricas Prometheus e health checks.

## Stack

- Bun 1.x e TypeScript em modo strict.
- NestJS 11, TypeORM e PostgreSQL 16.
- AWS SDK para SQS.
- LocalStack 3.8.1 para execução local da mensageria.
- Docker Compose.

## Arquitetura

O fluxo HTTP passa por controllers, casos de uso financeiros e uma `FinancialUnitOfWork`. A unidade de trabalho mantém a atualização da carteira, o lançamento no ledger, a idempotência, o Inbox e a Outbox na mesma transação PostgreSQL. O publisher entrega os eventos da Outbox ao SQS de saída. O consumer recebe mensagens do SQS de entrada e só confirma a mensagem depois que o processamento financeiro e o commit foram concluídos.

Os principais diretórios estão organizados em:

- `src/domain`: regras financeiras e entidades.
- `src/application`: casos de uso, portas e mensagens.
- `src/persistence`: PostgreSQL, TypeORM, repositórios e unidade de trabalho.
- `src/messaging`: SQS, publisher, consumer e workers.
- `src/http`: controllers, filtros e health checks.
- `src/observability`: logger estruturado e métricas.

Mais detalhes estão em [ARCHITECTURE.md](ARCHITECTURE.md) e as decisões históricas estão em [.docs/decisions.md](.docs/decisions.md).

## Pré-requisitos

- Bun 1.x.
- Docker Engine com Docker Compose.
- Portas locais 3000, 5432 e 4566 disponíveis.

## Configuração de ambiente

Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

No PowerShell:

```powershell
Copy-Item .env.example .env
```

Variáveis do arquivo `.env.example`:

| Variável | Finalidade |
| --- | --- |
| `APP_PORT` | Porta HTTP publicada pela aplicação. |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Credenciais e banco do PostgreSQL local. |
| `POSTGRES_PORT` | Porta local publicada pelo PostgreSQL. |
| `DATABASE_URL` | String de conexão usada pelos comandos executados no host. |
| `AWS_REGION` | Região usada pelo cliente SQS. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Credenciais de desenvolvimento aceitas pelo LocalStack; não use credenciais reais. |
| `LOCALSTACK_PORT` | Porta local publicada pelo LocalStack. |
| `SQS_ENDPOINT` | Endpoint SQS usado pela aplicação executada no host. |
| `SQS_MAIN_QUEUE` | Fila FIFO de entrada. |
| `SQS_DLQ` | Dead-letter queue da fila de entrada. |
| `SQS_OUTPUT_QUEUE` | Fila FIFO de eventos publicados pela Outbox. |

A aplicação também possui defaults para `PORT`, `SQS_OUTPUT_QUEUE`, parâmetros de polling, workers, leases, retry e tamanho dos lotes. Esses parâmetros opcionais estão centralizados na configuração da aplicação; o Compose define os endpoints internos necessários para a comunicação entre containers.

## Execução com Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
```

No PowerShell, substitua o primeiro comando por `Copy-Item .env.example .env`. O Compose inicia PostgreSQL, LocalStack e a aplicação. O script de inicialização do LocalStack cria as filas FIFO de entrada, DLQ e saída.

O bootstrap é executado automaticamente no estágio `READY` do LocalStack. Ele usa `/bin/sh` com line endings LF, é idempotente e preserva filas e mensagens existentes; a aplicação só fica pronta quando as três filas FIFO e o redrive da DLQ estão configurados. Os nomes `SQS_MAIN_QUEUE`, `SQS_DLQ` e `SQS_OUTPUT_QUEUE` são compartilhados entre o bootstrap e a aplicação.

Para interromper os containers sem remover os dados persistidos:

```bash
docker compose down
```

Os volumes nomeados `postgres-data` e `localstack-data` não são removidos por esse comando.

## Migrações

Com PostgreSQL disponível e as dependências instaladas:

```bash
bun run migration:run
bun run migration:revert
bun run migration:create -- AddMigrationName
```

Os comandos usam `DATABASE_URL` do ambiente. A imagem runtime do Compose contém o build da aplicação; execute as migrações pelo host com Bun.

## Endpoints HTTP

Os endpoints não exigem autenticação nesta implementação.

### Carteiras

- `POST /wallets`: cria uma carteira com `playerId` e `initialBalance`.
- `GET /wallets/:walletId`: consulta a carteira.
- `GET /wallets/:walletId/ledger?cursor=&limit=`: consulta o ledger paginado.
- `POST /wallets/:walletId/reconciliation`: executa reconciliação.

### Transações

- `POST /wagering/transactions`: recebe uma transação. Exige o header `Idempotency-Key` e aceita `X-Correlation-Id`.
- `GET /wagering/transactions/:transactionId`: consulta pelo identificador interno.
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`: consulta pela chave externa do provedor.

Os tipos aceitos são `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. Uma referência ainda não disponível pode resultar em `202 PENDING_REFERENCE`; uma nova operação pode retornar `201`, enquanto uma repetição idempotente retorna `200`. Erros de validação, conflito financeiro e falha temporária de infraestrutura usam os status correspondentes implementados pelos filtros HTTP.

## Mensageria SQS

O consumer lê a fila FIFO de entrada, valida o envelope, processa a transação e confirma a mensagem apenas após o commit. Mensagens inválidas são encaminhadas à DLQ; falhas transitórias permanecem sujeitas a redelivery e retry. O publisher lê a Outbox e publica eventos na fila FIFO de saída. O Inbox evita o reprocessamento efetivo de mensagens já concluídas.

No Compose, as filas são:

- `wager-transactions.fifo`: entrada.
- `wager-transactions-dlq.fifo`: DLQ, com redrive após cinco recebimentos.
- `wager-integration-events.fifo`: eventos publicados.

A fila de eventos de integração não é consumida pelo consumer financeiro interno; consumidores externos ou uma camada posterior de fan-out são responsáveis por esse contrato.

## Testes e validação

```bash
bun run typecheck
bun run build
bun run test:unit
bun run test:integration
bun run test:sqs
bun run test:migrations
bun run test
git diff --check
```

Os testes de integração e E2E que dependem de infraestrutura devem ser executados com PostgreSQL e LocalStack disponíveis. Para desenvolvimento, também estão disponíveis `bun test:watch`, `bun run start` e `bun run start:dev`.
Os cenários SQS usam LocalStack isolado por execução; eles não constituem validação contra AWS em produção.

## Health checks e métricas

- `GET /health/live`: verifica somente que o processo está vivo e permanece público.
- `GET /health/ready`: verifica PostgreSQL e SQS; retorna falha quando uma dependência não está disponível, sem encerrar o processo.
- `GET /metrics`: expõe métricas no formato Prometheus 0.0.4.

As métricas incluem transações por status, duplicatas, retries, mensagens enviadas explicitamente à DLQ, conflitos de lock, outbox lag em segundos, duração de processamento em segundos e divergências de reconciliação. Os labels são controlados por status, origem, componente e motivo; identificadores de carteira, transação, mensagem e evento não são labels. As métricas são mantidas em memória e reiniciam com o processo. A redrive automático do SQS não é observado diretamente pela aplicação.

Os logs são JSON estruturados e permitem correlação por `correlationId`, além de `messageId`, `transactionId`, `walletId`, `providerId`, `eventId`, `consumerName` e `attempt` quando disponíveis. Payloads financeiros, credenciais, tokens e valores monetários não são registrados.

## Estrutura de diretórios

```text
src/
  domain/            regras e entidades financeiras
  application/       casos de uso e portas
  persistence/       PostgreSQL, TypeORM e unidade de trabalho
  messaging/         SQS, publisher, consumer e workers
  http/              controllers, filtros e health checks
  observability/     logs e métricas
  database/migrations migrações PostgreSQL
test/                testes unitários, integração e E2E
docker/              inicialização local do LocalStack
.docs/               desafio, decisões e histórico de progresso
```

## Limitações conhecidas

- Não há autenticação ou autorização implementada; os endpoints são apropriados somente para o ambiente previsto pelo desafio.
- As métricas não têm armazenamento externo nem dashboards.
- O DLQ automático após o limite de recebimentos é responsabilidade do SQS e não é contado diretamente pelo processo.
- A configuração padrão é voltada ao ambiente local; disponibilidade, credenciais e escalabilidade de produção exigem operação externa.
- A imagem runtime não executa migrações automaticamente; elas devem ser aplicadas explicitamente.
- No schema público existente deste workspace há 43 associações históricas `wager_transactions`/wallet incompatíveis com a FK composta de player; elas não foram alteradas e a migration correspondente não foi aplicada nesse schema.

## Testes isolados de integração

`bun run test:unit` executa somente testes sem infraestrutura externa. `bun run test:integration` exige `DATABASE_URL` e LocalStack acessível, cria um schema PostgreSQL e três filas FIFO exclusivas para a execução, aplica as migrations e remove somente esses recursos ao final. `bun run test:sqs` executa apenas a regressão SQS com o mesmo isolamento. `bun run test:migrations` valida apply, revert e reapply em schema isolado. A integração falha explicitamente quando as dependências ou o isolamento não estão disponíveis; nenhum teste financeiro é ignorado silenciosamente.

## Documentação complementar

- [Desafio original](.docs/challenge.md)
- [Histórico de progresso](.docs/progress.md)
- [Decisões arquiteturais](.docs/decisions.md)
- [Arquitetura atual](ARCHITECTURE.md)
