# Arquitetura

## Estado e convenções

| Categoria | Estado |
|---|---|
| Requisitos do desafio | Definidos no [README.md](README.md) e copiados fielmente em [.docs/challenge.md](.docs/challenge.md). |
| Propostas arquiteturais | Hipóteses abaixo, ainda não aprovadas nem implementadas. |
| Decisões aprovadas | Preservação do README como fonte de verdade, separação documental e ADR-003 sobre TypeORM, migrações explícitas e readiness. |
| Funcionalidades implementadas e validadas | Bootstrap NestJS, conexão TypeORM, readiness separado, migrações reversíveis, domínio financeiro, persistência financeira e casos de uso transacionais; controllers e mensageria permanecem fora do escopo. |

## Visão geral

O desafio requer um serviço financeiro distribuído para transações de apostas por HTTP e SQS. Correção financeira, concorrência entre instâncias, idempotência persistente e recuperação após falhas são requisitos centrais. Em qualquer divergência, o README oficial prevalece.

## Requisitos arquiteturais definidos

- Bun 1.x, TypeScript estrito, NestJS, PostgreSQL, SQS por LocalStack/MiniStack, Docker Compose e migrations reversíveis/versionadas.
- MikroORM (preferencial) ou TypeORM; nenhum outro ORM.
- Dinheiro exato, sem `number`/`float`/`double`; valores contratuais como strings decimais.
- Invariantes também no schema: unicidade, imutabilidade e não-negatividade.
- Ledger imutável e saldo materializado consistente; sem saldo negativo.
- Wallet, ledger, inbox, outbox e evento de integração atômicos na mesma transação SQL quando aplicáveis.
- Entrega at-least-once, múltiplas instâncias e tolerância a duplicatas; FIFO não é a garantia final.
- Eventos só após commit; testes reais de PostgreSQL, SQS e concorrência.

## Componentes previstos — propostas

| Componente | Responsabilidade | Estado |
|---|---|---|
| API HTTP | Wallets, transações, consultas, reconciliação e health checks. | Não implementado |
| Casos de uso/domínio | Regras, Money, Wallet, transação, ledger e orquestração. | Domínio e casos de uso de wallet/transação implementados e testados |
| PostgreSQL | Estado, constraints, índices, inbox e outbox. | Wallets, transações e ledger persistidos; Inbox/Outbox não implementados |
| Consumidor SQS | Reusar caso de uso, registrar inbox e fazer ack após commit. | Não implementado |
| Worker de referências | Reprocessar `PENDING_REFERENCE`. | Não implementado |
| Publisher outbox | Publicar pendências concorrentemente e recuperar falhas. | Não implementado |
| Observabilidade | Logs JSON, métricas e health checks. | Não implementado |
| Autenticação | IdP externo ou ponto de extensão documentado. | Não decidido |

## Fluxo esperado — proposta

1. HTTP ou SQS valida e normaliza a entrada.
2. O caso de uso calcula o hash do payload de negócio e verifica idempotência persistente.
3. Uma transação SQL coordena a wallet, persiste a transação, saldo/ledger, inbox (SQS) e outbox.
4. Só após commit ocorre resposta HTTP ou ack da mensagem.
5. Publisher entrega eventos da outbox; consumidores devem suportar duplicatas.
6. Referência ausente fica `PENDING_REFERENCE` e é reprocessada por worker.

Este fluxo não está implementado; coordenação, ordenamento e políticas exatas dependem das decisões pendentes.

## Estratégias propostas, não aprovadas

### Consistência financeira

Usar a wallet como unidade de consistência e gravar mudança de saldo, ledger e transação em uma transação SQL. Constraints devem reforçar invariantes. A estratégia concorrente concreta ainda não foi escolhida.

### Concorrência e idempotência

Garantias persistentes do PostgreSQL devem resolver idempotência, e o controle deve ser por `walletId`, preservando paralelismo entre wallets. Lock pessimista, lock otimista com retry limitado e update condicionado permanecem alternativas. Canonização e algoritmo do hash também estão pendentes.

### Processamento, testes e observabilidade

API e SQS devem reutilizar o mesmo caso de uso, como exige o desafio; a semântica síncrona/assíncrona e os status HTTP precisam ser decididos. Os testes futuros devem cobrir unidade, integração real, paralelismo, redelivery, crash, retry/DLQ, outbox e fora de ordem. Logs estruturados sem dados sensíveis, métricas exigidas e liveness/readiness são requisitos, mas biblioteca/exportação/alertas ainda não foram definidos.

### Segurança e autenticação

Autenticação é opcional e não pontua. Se adotada, exige IdP externo; health fica aberto e SQS é canal interno confiável, sem dispensar validações de domínio. A decisão está pendente.

## Persistência financeira — Etapa 9

As tabelas `wallets`, `wager_transactions` e `wallet_ledger_entries` são criadas por migração reversível. Identificadores são UUID; `NUMERIC(20,2)` é usado para saldo, movimento e snapshots do ledger, e o driver TypeORM é tratado como `string`. O mapeamento transforma essa string em `Money.from({ amount, currency })`; a leitura do agregado usa `Wallet.rehydrate`, `WagerTransaction.rehydrate` e `WalletLedgerEntry.rehydrate`, sem decorators no domínio.

Constraints principais: `player_id + currency` único; `provider_id + external_transaction_id` único; idempotência única por `provider_id + idempotency_key`; enums de kind/status/direction; moeda ISO de três letras; valores não negativos; FKs de transação e ledger para wallet; FK opcional de referência para transação; e no máximo um lançamento por `(transaction_id, wallet_id)`. FKs compostas também impedem moeda divergente da wallet. Índices cobrem wallet/status, provider/status, referência e consultas de ledger por wallet/tempo. Um índice parcial impede duas reversões do mesmo tipo para a mesma referência.

O ledger é append-only: trigger PostgreSQL rejeita `UPDATE` e `DELETE`, e outro trigger verifica a aritmética `DEBIT`/`CREDIT` na inserção. A alteração de wallet, transação e lançamento deve ser feita pelo futuro caso de uso na mesma transação SQL. O repositório de wallet disponibiliza `FOR UPDATE` pessimista por linha, deixando wallets distintas em paralelo e evitando lost update entre instâncias.

Contratos estão em `src/application/ports`; implementações TypeORM ficam em `src/persistence/repositories`; entidades e mappers são infraestrutura. Nenhum controller, Inbox, Outbox, consumidor SQS ou processamento de apostas foi incluído.

## Casos de uso e orquestração — Etapa 10

`CreateWalletUseCase` e `ProcessWagerTransactionUseCase` dependem somente das portas da aplicação. `TypeOrmFinancialUnitOfWork` adapta `DataSource.transaction` e cria repositórios com o `EntityManager` transacional, garantindo que wallet, transação e ledger compartilhem a mesma conexão e commit.

Na criação financiada, a wallet nasce com o saldo materializado e a operação `OPENING`/ledger é criada na mesma unidade SQL; o lançamento usa `balanceBefore = 0.00` e preserva a versão inicial da wallet conforme o contrato de resposta. Falha de qualquer insert provoca rollback, impedindo wallet sem registro contábil.

No processamento, a aplicação verifica replay por `(providerId, idempotencyKey)`, bloqueia a wallet com `FOR UPDATE` e revalida a idempotência após o lock. A operação é aplicada pelo domínio, e wallet, transação e ledger são salvos atomicamente. Rejeições de negócio (`INSUFFICIENT_BALANCE`, `REVERSAL_INSUFFICIENT_BALANCE`, `INVALID_REFERENCE`, `REFERENCE_NOT_FOUND` e `CURRENCY_MISMATCH`) são persistidas como transações terminais sem ledger; falhas de infraestrutura fazem a transação SQL inteira retornar e não deixam estado parcial.

Uma violação concorrente de unicidade é tratada após o rollback da tentativa: a aplicação relê a chave de idempotência e retorna replay se o payload coincidir, ou conflito se divergir. A constraint PostgreSQL continua sendo a garantia final. Uma transação `PENDING_REFERENCE` é reprocessada pela mesma chave quando a referência passa a existir. `WIN` com referência ausente segue a limitação expressa no domínio: não possui transição `PENDING_REFERENCE` e é rejeitado como referência ausente.

## Decisões aprovadas na etapa de persistência

- TypeORM com `@nestjs/typeorm` e `pg` foi escolhido dentro das alternativas permitidas.
- A conexão é configurada por `DATABASE_URL`; `synchronize` e `migrationsRun` permanecem desabilitados.
- O `DataSource` compartilhado oferece os comandos Bun `migration:create`, `migration:run` e `migration:revert`.
- O endpoint de liveness permanece independente do banco; `GET /health/ready` consulta PostgreSQL com `SELECT 1`.

## Decisões aprovadas na etapa Money

- `Money` usa `bigint` privado em centavos, sem `number`, `float` ou `double` para representação ou cálculo.
- Entradas monetárias são strings decimais não negativas com até duas casas; saída é sempre uma string com duas casas.
- `Money` permanece independente de NestJS, TypeORM, PostgreSQL e SQS.

## Decisões aprovadas na etapa Wallet e WalletLedgerEntry

- `Wallet` possui construtor privado, factories `open`/`rehydrate`, identificadores somente leitura, saldo encapsulado e `version` iniciando em `1`.
- `debit` e `credit` recebem uma especificação com `id`, `transactionId`, `money` e data opcional, retornam o `WalletLedgerEntry` correspondente e só alteram o saldo após a validação aritmética do lançamento.
- Moeda incompatível, movimentação negativa e débito sem saldo são rejeitados; a versão só incrementa quando o saldo efetivamente muda. O lançamento é criado mesmo para movimento zero, mas a versão permanece igual.
- `WalletLedgerEntry` é estruturalmente imutável. `create` valida `balanceBefore ± money === balanceAfter`; `rehydrate` reconstrói sem revalidar a transição, e `isBalanced()` permite consultar o estado persistido.
- A atomicidade entre wallet e ledger não é simulada no domínio: será garantida pela mesma transação SQL quando a persistência for implementada. A transação interna `OPENING` e seu lançamento também ficam para essa camada de caso de uso/persistência.

## Decisões aprovadas na etapa WagerTransaction

- `WagerTransaction` possui factories `create`/`rehydrate`, identificadores e dados de negócio imutáveis, `Money`, referência externa opcional e estado encapsulado.
- `create` inicia em `PENDING`. As transições permitidas são `PENDING → PENDING_REFERENCE`, `PENDING/PENDING_REFERENCE → PROCESSED`, `REJECTED` ou `FAILED`; os três estados finais são terminais.
- `REFUND` e `ROLLBACK` exigem referência externa. A entidade valida referências carregadas por provider, player, wallet, moeda e round; `REFUND` só aceita `BET`, `ROLLBACK` aceita `BET`, `WIN` ou `REFUND`, e reversões exigem estado `PROCESSED` e valor igual.
- A ausência ou duplicidade de referência não é resolvida por memória: `PENDING_REFERENCE`, consulta persistente e constraints futuras serão responsabilidade da aplicação/persistência. `OPENING` é mantido apenas como tipo interno.
- `LOSS` não afeta saldo e não possui direção de ledger. `BET` é débito, `WIN`/`REFUND` são créditos e `ROLLBACK` inverte a direção da referência.

## Decisões pendentes

- Retry de deadlock/timeout; o caso de uso atual deixa esses erros para a camada de entrada decidir, sem repetir automaticamente uma operação financeira.
- Idempotência, JSON canônico e payload hash.
- Processamento HTTP síncrono versus assíncrono e status HTTP.
- Tentativas, backoff, visibilidade, DLQ e shutdown da SQS.
- TTL/reprocessamento de referências ausentes.
- Claim/lock e retry de publishers concorrentes da outbox.
- Failure codes, autenticação/IdP, OpenAPI e instrumentação.

## Limitações conhecidas

O schema inclui a tabela técnica histórica `migration_probe` e as três tabelas financeiras da Etapa 9; inbox, outbox, consumers e regras de processamento ainda não existem.

O comando de migração foi validado no container da aplicação, usando a rede interna do Compose. Neste ambiente, a porta IPv4 `5432` do host também é ocupada por um PostgreSQL nativo, portanto o acesso do CLI executado no host pode atingir outra instância; isso não afeta a conexão da aplicação com o serviço `postgres` do Compose.
