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

## Quickstart

No clone do repositório, instale as dependências, copie a configuração de exemplo e inicie PostgreSQL, LocalStack e a aplicação:

```bash
bun install
cp .env.example .env
docker compose up -d --build
```

No PowerShell, use `Copy-Item .env.example .env` no lugar do `cp`. O Compose publica a aplicação em `APP_PORT` (padrão `3000`), PostgreSQL em `POSTGRES_PORT` (padrão `5432`) e LocalStack em `LOCALSTACK_PORT` (padrão `4566`). Dentro do container, a aplicação escuta em `PORT=3000`; o Compose mapeia `${APP_PORT:-3000}:3000`.

O Compose **não aplica migrations**. Com os containers ativos, execute-as no host com Bun e `DATABASE_URL` apontando para a porta publicada do PostgreSQL e para as credenciais configuradas. O Bun lê o `.env` copiado no diretório do projeto; se a URL não estiver disponível no processo, defina-a explicitamente, por exemplo no PowerShell:

```powershell
$env:DATABASE_URL = "postgresql://wager:change-me-local-only@localhost:5432/wager"
bun run migration:run
```

Em shells Bash, a mesma configuração pode ser exportada com `export DATABASE_URL=postgresql://wager:change-me-local-only@localhost:5432/wager` antes de `bun run migration:run`. Se alterar `POSTGRES_PORT`, usuário, senha ou banco, ajuste a URL de acordo.

Depois da inicialização pelo Compose e da aplicação das migrations, confirme liveness e readiness:

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

Substitua `3000` pela porta configurada em `APP_PORT`, se diferente. O liveness verifica o processo; readiness verifica PostgreSQL e SQS. A aplicação já é iniciada pelo Compose. No Windows PowerShell, use `curl.exe` no lugar de `curl`. Para executá-la no host durante desenvolvimento, use `bun run start:dev` após configurar `DATABASE_URL` e os endpoints SQS acessíveis no host.

## Configuração de ambiente

O Quickstart acima cria `.env` a partir do `.env.example`. Ajuste os valores locais nesse arquivo quando as portas ou nomes padrão não estiverem disponíveis.

Variáveis do `.env.example` e configurações opcionais reconhecidas pelo Compose/aplicação:

| Variável | Finalidade |
| --- | --- |
| `APP_PORT` | Porta publicada no host pelo Compose; o container continua escutando em `PORT=3000`. |
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

`SQS_OUTPUT_QUEUE` é opcional e não está escrito no `.env.example`; Compose e aplicação usam `wager-integration-events.fifo` como default.

A aplicação usa `PORT=3000` por padrão quando executada no host; no Compose, esse valor é definido explicitamente e `APP_PORT` controla apenas a porta do host. Os parâmetros operacionais opcionais relevantes e seus defaults estão na tabela abaixo. O Compose configura os endpoints internos para a comunicação entre containers.

| Variável | Default no código | Efeito |
| --- | --- | --- |
| `MESSAGING_WORKERS_ENABLED` | habilitado quando diferente de `false` | Ativa consumer e publisher SQS. |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | Visibilidade da mensagem durante processamento. |
| `SQS_RECEIVE_WAIT_SECONDS` | `0` | Espera máxima por mensagem em cada polling SQS. |
| `SQS_BATCH_SIZE` | `10` | Lote máximo recebido pelo consumer. |
| `OUTBOX_LEASE_MS` / `OUTBOX_BATCH_SIZE` | `30000` / `10` | Lease e lote de claims da Outbox. |
| Retry do publisher da Outbox | `1000` ms, backoff exponencial limitado a `60000` ms | Agendamento persistido após falha de publicação; limites são definidos no código, sem variável de ambiente. |
| Retry do consumer SQS | `2^receiveCount` segundos, limitado a `60` s e ao visibility timeout | Ajusta a visibilidade para redelivery; DLQ automática após `maxReceiveCount=5` no bootstrap local. |
| `PENDING_REFERENCE_INTERVAL_MS` | `1000` | Intervalo do worker de referências pendentes. |
| `PENDING_REFERENCE_LEASE_MS` | `30000` | Lease de claim da pendência. |
| `PENDING_REFERENCE_RETRY_BASE_MS` / `PENDING_REFERENCE_RETRY_MAX_MS` | `1000` / `60000` | Base e limite do backoff exponencial. |
| `PENDING_REFERENCE_TTL_MS` | `900000` (15 min) | Prazo para resolver a referência antes da rejeição. |

O consumer também aceita `SQS_SHUTDOWN_TIMEOUT_MS`; seu default é derivado do timeout de visibilidade (`max(1000, visibilityTimeoutSeconds × 1000 − 1000)`).

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

Os tipos aceitos são `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. Uma nova operação processada retorna `201`; replay idempotente retorna `200`; uma `REFUND` ou `ROLLBACK` cuja referência ainda não chegou retorna `202` com `PENDING_REFERENCE`. Essa resposta HTTP descreve o estado persistido da transação e o worker poderá retomá-la; não é uma resposta HTTP gerada pelo consumer SQS.

Exemplo de submissão e resposta processada:

```http
POST /wagering/transactions HTTP/1.1
Content-Type: application/json
Idempotency-Key: provider-a:bet-123
X-Correlation-Id: request-9f3a

{
  "providerId": "provider-a",
  "externalTransactionId": "bet-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "providerId": "provider-a",
  "externalTransactionId": "bet-123",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" },
  "status": "PROCESSED",
  "idempotentReplay": false,
  "balance": { "amount": "975.00", "currency": "BRL" }
}
```

O mesmo `Idempotency-Key` com conteúdo financeiro diferente retorna `409 CONFLICT`; payload inválido retorna `400 INVALID_PAYLOAD`. Uma rejeição de negócio como saldo insuficiente retorna `422` e inclui o estado `REJECTED` e seu `failureCode`.

Exemplo de conflito de idempotência (mensagem genérica produzida pelo filtro):

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "statusCode": 409,
  "code": "CONFLICT",
  "message": "Idempotency key was used with a different payload"
}
```

| HTTP | Situação | Interpretação |
| --- | --- | --- |
| `200` | Consulta bem-sucedida ou replay idempotente de operação já conhecida | Consulta retorna o recurso; replay reapresenta o resultado persistido sem reaplicar o efeito. |
| `201` | Nova transação processada, wallet criada ou pedido de reconciliação concluído | Para transação financeira, confira `status`; reconciliação informa o resultado em `consistent`/`difference`. |
| `202` | Referência de `REFUND`/`ROLLBACK` ainda ausente | Transação persistida como `PENDING_REFERENCE`; worker tentará resolvê-la. |
| `400` | Corpo inválido, `Idempotency-Key` ausente, cursor inválido ou limite fora da faixa | Corrija o request antes de reenviar. |
| `404` | Wallet ou transação consultada não encontrada | O recurso não existe. |
| `409` | Chave idempotente com payload diferente, identidade externa duplicada ou wallet já existente | Conflito com estado já persistido. |
| `422` | Operação rejeitada por regra financeira ou referência inválida | Resultado terminal de negócio; consulte `status` e `failureCode`. |
| `503` | Falha transitória classificada durante uma operação, ou dependência indisponível em `/health/ready` | A falha operacional classificada contém `retryable: true`; readiness retorna `status: not_ready` e identifica a dependência indisponível. |

`POST /wallets/:walletId/reconciliation` retorna `201` tanto quando consistente quanto quando encontra divergência; a divergência está em `consistent`/`difference`, é observada e não é corrigida automaticamente. Erros inesperados não classificados retornam `500`.

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

Os testes de integração e E2E que dependem de infraestrutura devem ser executados com PostgreSQL e LocalStack disponíveis. Para desenvolvimento, também estão disponíveis `bun run test:watch`, `bun run start` e `bun run start:dev`.
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
  http/              controllers financeiros, validação e filtros
  health.controller.ts
  readiness.controller.ts
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

## Testes isolados de integração

`bun run test:unit` executa somente testes sem infraestrutura externa. `bun run test:integration` exige `DATABASE_URL` e LocalStack acessível, cria um schema PostgreSQL e três filas FIFO exclusivas para a execução, aplica as migrations e remove somente esses recursos ao final. `bun run test:sqs` usa o mesmo runner isolado e executa `test/sqs.regression.integration.test.ts` **e** `test/distributed-recovery.integration.test.ts`; esta última cobre recuperação distribuída além dos cenários SQS. `bun run test:migrations` valida apply, revert e reapply em schema isolado. A integração falha explicitamente quando as dependências ou o isolamento não estão disponíveis; nenhum teste financeiro é ignorado silenciosamente.

## Documentação complementar

- [Desafio original](.docs/challenge.md)
- [Histórico de progresso](.docs/progress.md)
- [Decisões arquiteturais](.docs/decisions.md)
- [Arquitetura atual](ARCHITECTURE.md)
