# 2026-10-31 10:53:19 -03:00 — Etapa 17: auditoria final e preparacao da entrega

**O que foi feito:**

- Auditado o Git: branch atual `feature/final-hardening-2`, um commit (`b718c1b`) a frente de `develop`, dois commits a frente de `feature/final-hardening`, sem commits novos nesta etapa e com somente alteracoes de trabalho pendentes.
- Confrontado o enunciado integral em `.docs/challenge.md` com dominio, persistencia, idempotencia, concorrencia, SQS, API, infraestrutura, observabilidade, seguranca, testes e documentacao.
- Adicionado teste real com 50 debitos identicos usando tres processos de aplicacao; teste real de `REFUND` antes do `BET` via SQS; e corrida real entre dois publishers independentes para a mesma Outbox.
- Corrigida a documentacao para refletir a topologia real: a fila de eventos da Outbox nao e consumida pelo consumer financeiro interno; os testes SQS usam LocalStack, nao AWS de producao; e nao ha autenticacao implementada.
- Investigada a origem provavel das 43 associacoes historicas inconsistentes. Elas permanecem intactas; a origem mais provavel sao fixtures legadas anteriores ao hardening, sem prova suficiente para saneamento automatico.

**Validacao final:**

- `bun run test:unit`: 47 pass.
- `bun run test:integration`: 41 pass, 252 expects.
- `bun run test:sqs`: 11 pass, 121 expects.
- `bun run test:migrations`: exit 0; schema isolado com apply, revert, reapply, zero violacoes e duas constraints validadas; schema publico consultado somente leitura com 43 violacoes e constraints da Etapa 15 ausentes.
- `bun run test`: 47 testes unitarios + 41 de integracao pass, 0 falhas.
- `bun run typecheck`, `bun run build` e `git diff --check`: aprovados.
- Health HTTP: liveness `200 ok`; readiness `503` porque as filas padrao nao estavam presentes no LocalStack persistido, embora PostgreSQL, LocalStack e app estivessem `healthy` no Compose. Nenhuma fila ou volume foi removido.
- `bun pm scan`: nao executado por ausencia de scanner configurado; nao ha conclusao de vulnerabilidades de dependencias.

**Arquivos alterados nesta etapa:**

- `test/distributed-recovery.integration.test.ts`
- `scripts/verify-migrations.ts`
- `README.md`
- `ARCHITECTURE.md`
- `.docs/decisions.md`
- `.docs/progress.md`

**Parecer preliminar:**

- A implementacao e os testes isolados reais atendem os cenarios principais do desafio, mas a entrega fica **PRONTA COM RESSALVAS** enquanto as 43 violacoes historicas e a aplicacao da migration composta no schema publico nao tiverem decisao operacional explicita. A topologia de saida tambem depende de consumidor externo/futuro, e a validacao executada foi contra LocalStack.

# 2026-10-31 10:38:00 -03:00 — Etapa 16: concorrência real, falhas e recuperação

**O que foi feito:**

- Reforçado `test/distributed-recovery.integration.test.ts` para observar redelivery real pelo `ApproximateReceiveCount >= 2`, confirmar ACK após restart, confirmar a presença da mensagem publicada antes do crash do publisher e verificar uma única entrega FIFO, `published_at`, saldo, transação e ledger.
- Reforçado `scripts/verify-migrations.ts` para consultar o schema público somente leitura, listar violações históricas identificadas e executar `VALIDATE CONSTRAINT` somente quando as duas constraints existirem e não houver violações.

**Validação real:**

- PostgreSQL 16, LocalStack 3.8.1 e aplicação Compose permaneceram `healthy`; nenhuma fila, volume ou dado compartilhado foi removido.
- Schema público: 43 violações em `wager_transactions` para `fk_transactions_wallet_player`, 0 violações em `fk_ledger_transaction_wallet`; as constraints da Etapa 15 não estão aplicadas no schema público (`pg_constraint` retornou 0). As 43 linhas são `provider-integration`/`PENDING` e foram apenas identificadas, sem alteração.
- Schema de migrations isolado: apply, revert, reapply, 0 violações históricas e duas constraints validadas.
- `test:unit`: 47 pass; `test:integration`: 39 pass; `test:sqs`: 9 pass em cada uma de 3 execuções consecutivas; `test`: 47 + 39 pass; `typecheck`, `build` e `git diff --check`: aprovados.
- Cenários reais A/B/C, três processos independentes de aplicação, crash do consumer após commit, crash do publisher após `SendMessage`, retry, visibility timeout, redelivery, DLQ automática e reconciliação foram executados contra PostgreSQL/LocalStack reais.

**Falha observada e corrigida durante a validação:**

- A primeira versão da asserção tentou usar `Inbox.attempts` para provar redelivery de uma mensagem já processada; a implementação preserva esse contador nesse caso. A evidência foi corrigida para usar `ApproximateReceiveCount` diretamente no SQS, sem mudar o comportamento financeiro.

**Arquivos alterados:**

- `scripts/verify-migrations.ts`
- `test/distributed-recovery.integration.test.ts`
- `.docs/progress.md`

**Limitações:**

- As 43 violações históricas do schema público permanecem pendentes de decisão do responsável, pois corrigi-las automaticamente violaria a regra de não alterar dados financeiros existentes. A migration composta só pode ser aplicada/validada nesse schema após tratamento explícito desses registros.

# Diário de progresso

## 2026-10-31 03:34:49 — Etapa 15: hardening estrutural e isolamento da suíte

**O que foi feito:**

- Separados comandos unitários, integração completa, regressão SQS e ciclo reversível de migrations; testes de integração agora exigem PostgreSQL e LocalStack e falham explicitamente quando a infraestrutura não está disponível.
- O runner cria schema PostgreSQL e filas FIFO exclusivos por execução, desabilita workers externos, executa a suíte e remove somente os recursos criados por ele.
- Corrigido o teste SQS para identificar o `transactionId` da operação testada, com filas e Outbox isolados; adicionadas validações de mensagens SQS, UUIDs, enums, Money e propriedades inesperadas.
- Criada migration reversível com chaves compostas para proteger associações wallet/player/currency e transaction/wallet. As FKs são `NOT VALID` para preservar dados legados existentes, mas rejeitam novas associações inconsistentes.
- Corrigidos o mapeamento de falhas transitórias para HTTP 503 genérico/retryable e o reset do gauge de Outbox lag quando não há pendências.

**Validação:**

- `bun run test:unit` executa sem infraestrutura externa; `bun run test:integration` e `bun run test:sqs` usam recursos efêmeros exclusivos; `bun run test:migrations` valida apply/revert/reapply em schema isolado.
- Nenhum volume ou dado do banco principal foi removido; não foi criado commit ou merge.

## 2026-10-31 03:00:49 -03:00 — Correção e padronização da documentação do projeto

**O que foi feito:**

- Reconstruído o `README.md` como guia principal de apresentação, configuração, execução, endpoints, mensageria, testes e limitações reais.
- Reposicionado o registro da Etapa 13 para o topo histórico, depois dos registros da Etapa 12 do mesmo dia, preservando seu conteúdo e sem inventar horário.
- Mantido todo o histórico existente do `progress.md`; registros antigos sem horário confirmado continuam explicitamente sem horário.
- Revisados `ARCHITECTURE.md` e `.docs/decisions.md` para distinguir arquitetura implementada, decisões históricas, decisões superadas e limitações atuais.
- Conferidos scripts de `package.json`, variáveis de `.env.example`, endpoints dos controllers e links relativos da documentação.

**Validação:**

- `git diff --check` executado sem erros.
- Nenhum arquivo de código, teste, dependência ou configuração de execução foi alterado.

**Observação cronológica:**

- Este registro usa o horário real obtido do ambiente: `2026-10-31 03:00:49 -03:00`.
- O horário exato dos registros da Etapa 13 e de alguns registros de 2026-10-31 não está confirmado no histórico disponível; as datas foram preservadas sem atribuir horário artificial.

## 2026-10-31 — Etapa 13: observabilidade e métricas operacionais

**O que foi feito:**

- Criado `StructuredLogger`, com saída JSON em uma linha, allowlist de contexto e filtragem de payloads financeiros, credenciais, tokens e mensagens de erro livres.
- Instrumentados recebimento HTTP, processamento/rejeição/replay financeiro, Outbox, falhas de publish, consumer SQS, redelivery, retry, DLQ, worker de referências, reconciliação e readiness.
- Criado `MetricsService` sem dependência externa e endpoint público `GET /metrics` no formato Prometheus 0.0.4.
- Implementadas métricas de transações por status, duplicatas, retries, DLQ explícita, conflitos de lock, outbox lag, latência de processamento e divergência de reconciliação.
- Labels são controladas e não carregam walletId, transactionId, messageId ou valores monetários.
- Correlation ID HTTP/SQS passou a ser validado e propagado pelo caso de uso, Outbox, Inbox, publisher, consumer e worker; SQS usa messageId somente como fallback.
- Corrigido o worker de referências para persistir o próximo retry/backoff quando a referência ainda não existe, sem contar esse retry como nova duplicata financeira.
- Readiness permanece público e separado: liveness não acessa dependências; readiness verifica PostgreSQL e SQS e retorna 503 sem derrubar o processo.

**Testes e validação:**

- Adicionado `test/observability.test.ts`, cobrindo formato JSON, correlation ID, ausência de dados sensíveis, contadores, labels, lag, latência, readiness com dependências disponíveis/indisponíveis e liveness independente.
- `bun run typecheck` aprovado.
- `bun run build` aprovado.
- `bun test` sem dependências reais revelou apenas o comportamento ambiental esperado: E2E exige PostgreSQL; os testes unitários novos passaram.
- PostgreSQL real e LocalStack reais foram iniciados pelo Compose sem remover volumes; migrations pendentes: nenhuma.
- Suíte real com PostgreSQL/LocalStack: 71 pass, 1 falha inicial por dois consumidores concorrendo na mesma fila (container app existente); após parar temporariamente somente esse container, `test/sqs.regression.integration.test.ts`: 1 pass.
- `git diff --check` aprovado.

**Limitações conhecidas:**

- A métrica de DLQ contabiliza envios explícitos da aplicação; o redrive automático do SQS precisa de observação externa.
- As métricas ficam em memória e reiniciam com o processo; não há Prometheus/Grafana/OTel por não serem necessários ao escopo.
- O `README.md` da raiz estava vazio no checkout anterior; esta correção o reconstrói como documentação principal.

## 2026-10-31 — Validação final da correção da auditoria

- Migration `CreatePendingReferenceLeases1710000003000` executada, revertida e reaplicada com sucesso no banco isolado `wager_messaging_validation`.
- LocalStack confirmou as três filas: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-integration-events.fifo`; readiness retornou PostgreSQL/SQS `up`.
- Processo NestJS real + LocalStack validou duas mensagens com IDs de envelope diferentes: uma transação `PROCESSED`, um lançamento e dois registros Inbox `PROCESSED`; evento de saída recebido na FIFO dedicada.
- Suíte final: `bun run typecheck`, `bun run build`, `bun test` e `git diff --check` aprovados; `67 pass`, `0 fail`, `265 expect`.
- Normalização monetária do hash foi reforçada para que representações equivalentes como `10.0` e `10.00` tenham o mesmo hash.
- App Compose foi reconstruído e reiniciado com sucesso; volumes e banco principal foram preservados. Nenhum commit ou merge foi criado.

## 2026-10-30 — Fechamento da validação da Etapa 12

- `bun run typecheck`, `bun run build`, `bun test` com PostgreSQL real e `git diff --check` aprovados.
- Resultado final: 60 testes pass, 0 fail e 242 expectativas.
- App final reconstruído e healthy; readiness confirmou PostgreSQL/SQS `up`; nenhum commit, merge ou alteração de `develop`/`main` foi feito.
## 2026-10-30 — Etapa 12: Transactional Outbox, Inbox e SQS

**O que foi feito:**

- Adicionado `@aws-sdk/client-sqs`, readiness SQS e workers `OutboxPublisher`/`WagerTransactionConsumer` com shutdown pelo ciclo de vida NestJS.
- Criadas entidades Inbox/Outbox e migration reversível `1710000002000-CreateMessagingPersistence`, com JSONB, índices, constraints, leases, tentativas, falhas e unicidade persistente.
- Criados eventos versionados `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` e `WagerTransactionPendingReference`.
- Integrada a Outbox à mesma unidade SQL dos casos de uso financeiros, sem serializar entidades ORM ou instâncias `Money`; `LOSS` também produz evento processado.
- Implementados claim distribuído com `FOR UPDATE SKIP LOCKED`, recuperação de leases, backoff de publicação e Inbox com `ON CONFLICT DO NOTHING` + `FOR UPDATE`.
- Consumer reutiliza `ProcessWagerTransactionUseCase`, confirma SQS apenas depois do commit, diferencia terminal/transitório e encaminha mensagens inválidas à DLQ.
- Adicionados testes de eventos e integração PostgreSQL para atomicidade, rollback e concorrência Inbox.

**Validação real:**

- PostgreSQL e LocalStack reais ficaram saudáveis; migration aplicada e tabelas `inbox_messages`/`outbox_messages` confirmadas.
- Readiness retornou PostgreSQL e SQS `up`; FIFO confirmou `VisibilityTimeout=30`, `ReceiveMessageWaitTimeSeconds=0` e redrive `maxReceiveCount=5`.
- Publisher real marcou eventos com `published_at` após publicação; claim foi corrigido após auditoria do retorno SQL.
- Mensagem SQS válida processou Inbox, transação e saldo real (`100.00` → `75.00`); mensagens inválidas foram auditadas como `FAILED` e roteadas à DLQ.
- `bun run typecheck`, `bun run build` e testes messaging adicionais passaram; a suíte completa com PostgreSQL real será repetida na validação final.

**Limitação documentada:**

- O README define somente a FIFO de wagering e sua DLQ, sem fila de eventos de saída. Para não inventar uma topologia, eventos Outbox usam a FIFO declarada e o consumer ACKa envelopes `eventType` sem processá-los financeiramente; uma fila pub/sub separada exige decisão contratual.
## 2026-10-30 — Complemento Etapa 11: suíte E2E HTTP automatizada

**O que foi feito:**

- Criado `test/http.e2e.test.ts`, iniciando `src/main.ts` como processo NestJS real em porta dinâmica.
- As requisições usam HTTP real com `fetch`; persistência é verificada no PostgreSQL real via TypeORM.
- Cada cenário usa UUIDs e chaves externas novas, sem limpeza de volume ou dependência de ordem.
- Cobertos criação/duplicidade/consulta de wallet, ledger com cursor, consultas interna/externa, submissão, replay/conflito, validação, ausência de idempotência, rejeição, referência pendente, reconciliação consistente/divergente e health.
- Corrigidos imports de interfaces como `import type`, revelados pela execução direta do TypeScript com Bun.

**Validação:**

- `bun test test/http.e2e.test.ts` → 10 pass, 0 fail, 52 expectativas, contra PostgreSQL real e processo NestJS real.
- O cenário de falha de infraestrutura valida falha HTTP de dependência inalcançável; o comportamento de readiness com PostgreSQL indisponível permanece coberto pelo teste do controller, sem parar o serviço compartilhado nem apagar dados.

## 2026-10-30 — Etapa 11: API HTTP e integração dos casos de uso

**O que foi feito:**

- Implementados `POST/GET /wallets`, ledger por cursor opaco, consultas de transações interna/externa, submissão de wagering e reconciliação.
- Criados contratos/serializadores HTTP, validação estrita de propriedades, UUIDs, enums e Money como string decimal.
- Integrados `CreateWalletUseCase`, `ProcessWagerTransactionUseCase` e novo `ReconcileWalletUseCase` por DI do NestJS.
- Adicionado filtro centralizado de erros, incluindo conflito, inexistência, rejeição de negócio, pendência de referência e indisponibilidade de infraestrutura.
- Readiness PostgreSQL foi preservada; SQS permanece explicitamente não verificado por não haver integração nesta etapa.

**Validação:**

- `bun run typecheck`, `bun run build` e `git diff --check` aprovados.
- `bun test`: 32 aprovados e 17 testes PostgreSQL ignorados quando `DATABASE_URL` não estava definido.
- Docker Compose/PostgreSQL/LocalStack iniciados; migrações já aplicadas; aplicação reconstruída e saudável.
- Fluxo HTTP real validado: criação de wallet, BET processada e saldo atualizado de `100.00` para `75.00`, além de liveness/readiness `200`.

**Limitações e próximos passos:**

- Não há cliente SQS nesta etapa; readiness não simula uma verificação positiva de SQS.
- Testes E2E automatizados completos devem ser executados no ambiente CI com Docker e incluídos na próxima rodada de endurecimento da API; consumer, inbox/outbox, retry/DLQ e autenticação permanecem fora do escopo.

## 2026-10-30 14:17:11 -03:00 — Etapa 10: casos de uso e orquestração financeira

**O que foi feito:**

- Criada a porta `FinancialUnitOfWork` e a implementação `TypeOrmFinancialUnitOfWork`, usando `DataSource.transaction` e os repositórios com o mesmo `EntityManager` transacional.
- Implementado `CreateWalletUseCase`: wallet vazia sem abertura; wallet financiada com `OPENING` e `CREDIT` no ledger na mesma transação; conflitos de player/moeda tratados sem confiar apenas no pre-check.
- Implementado `ProcessWagerTransactionUseCase` para `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
- Aplicado lock pessimista da wallet durante a operação, validação de player/moeda, transições de domínio, persistência atômica e rejeições auditáveis sem ledger.
- Implementada idempotência por chave/payload, tratamento de corrida de unicidade PostgreSQL, conflito de payload e replay sem novo lançamento.
- Implementado reprocessamento de `PENDING_REFERENCE` quando a referência passa a existir.
- Atualizados os contratos para consultas de transação com `FOR UPDATE`.
- Criados 10 testes de integração adicionais contra PostgreSQL real cobrindo criação, `OPENING`, rollback, todas as operações, idempotência, reversões, referências fora de ordem e concorrência.
- Atualizados `ARCHITECTURE.md` e `.docs/decisions.md` com a unidade de trabalho, ordem dos locks, atomicidade e política de idempotência.

**Ambiguidade registrada:**

- O domínio existente só permite `PENDING_REFERENCE` para `REFUND` e `ROLLBACK`; `WIN` com referência informada e ausente é rejeitado como `REFERENCE_NOT_FOUND`, preservando o contrato atual sem inventar uma nova transição.

**Validação real:**

- `bun test test/financial-use-cases.integration.test.ts` → 10 pass, 0 fail, 40 expectativas, usando PostgreSQL do Docker Compose.
- `bun run typecheck` → aprovado.
- `bun run build` → aprovado.
- `bun test` → 45 pass, 0 fail, 177 expectativas, 0 skipped.
- `git diff --check` → aprovado.

**Escopo preservado:** não foram implementados controllers HTTP, consumer SQS, Inbox, Outbox, publicação de eventos, reconciliação, observabilidade avançada ou autenticação. Nenhuma migração foi necessária.

## 2026-10-30 14:02:17 -03:00 — Auditoria e validação final da Etapa 9

**Auditoria e correções:**

- Confirmada a causa dos testes anteriormente ignorados: `DATABASE_URL` ausente acionava `describe.skip` na suíte de integração.
- Confirmado que o Docker Engine/Desktop e PostgreSQL 16 do Compose estavam acessíveis e healthy; os testes usaram `postgresql://wager:...@localhost:5432/wager`.
- Identificado e corrigido o `afterAll` da integração, que desfazia migrações do banco compartilhado. A suíte agora apenas encerra a conexão, preservando dados e schema.
- Identificados identificadores fixos que tornavam a suíte não repetível após a primeira execução; external transaction IDs e idempotency keys de constraint passaram a ser únicos por execução.
- Adicionada cobertura real para FK de referência, unicidade de idempotência, trigger de aritmética do ledger e bloqueio pessimista por wallet em duas transações SQL concorrentes.

**Validação PostgreSQL real:**

- `docker compose up -d postgres` e `docker compose ps` → PostgreSQL healthy, sem remoção de volumes.
- `bun run migration:run` no banco principal → aplicadas as duas migrações pendentes.
- Inspeção SQL → confirmadas as três tabelas financeiras, 16 índices, 25 constraints e os triggers `wallet_ledger_entries_arithmetic` e `wallet_ledger_entries_immutable`.
- Banco isolado `wager_migration_validation` → `migration:run`, `migration:revert` e `migration:run` executados com sucesso; reaplicação restaurou as tabelas financeiras.
- Teste de integração dedicado → 3 pass, 0 fail, 16 expectativas.
- Suíte completa `bun test` com `DATABASE_URL` real → 35 pass, 0 fail, 137 expectativas, 0 skipped.

**Validação final:**

- `bun run typecheck` → aprovado.
- `bun run build` → aprovado.
- `git diff --check` → aprovado; somente aviso informativo de conversão LF/CRLF.

**Resultado:**

A persistência financeira da Etapa 9 foi validada contra PostgreSQL real. Não foram implementados API HTTP, processamento completo de apostas, Inbox, Outbox ou SQS. O banco isolado de validação foi preservado para auditoria; nenhum volume ou dado do banco principal foi removido.

## 2026-10-30 13:52:21 -03:00 — Etapa 9: persistência financeira PostgreSQL e TypeORM

**O que foi feito:**

- Criadas as entidades TypeORM isoladas `WalletEntity`, `WagerTransactionEntity` e `WalletLedgerEntryEntity`.
- Criada a migração reversível `CreateFinancialPersistence1710000001000` para wallets, transações e ledger, com UUIDs, NUMERIC(20,2), constraints, FKs, índices, unicidades, trigger de imutabilidade e validação aritmética.
- Criados mappers explícitos com `Money` como string decimal e reidratação pelas factories do domínio.
- Criados contratos de repositório na camada de aplicação e implementações TypeORM para wallet, transação, referências externas/status e ledger.
- Preparado lock pessimista por `walletId` para transações SQL futuras; nenhum lock global em memória foi criado.
- Criado teste de integração que usa `DataSource` real quando `DATABASE_URL` está presente, cobrindo persistência/reidratação, precisão, unicidade, FK, saldo negativo e imutabilidade.
- Atualizados `ARCHITECTURE.md` e `.docs/decisions.md` com schema, mapeamento, concorrência e trade-offs.

**Validação real:**

- `bun run typecheck` → aprovado.
- `bun run build` → aprovado.
- `bun test` → 32 aprovados, 4 ignorados por ausência de `DATABASE_URL`; não é aprovação da integração PostgreSQL.
- `docker compose up -d postgres` → não executado: Docker Engine indisponível no ambiente (`docker_engine` não encontrado).
- Migração e teste de integração contra PostgreSQL real → pendentes pela indisponibilidade do Docker.

**Escopo preservado:** não foram implementados processamento completo de apostas, controllers, Inbox, Outbox ou consumidor SQS.

**Pendências:** iniciar o Docker/PostgreSQL e executar o teste de integração, `migration:run`, `migration:revert` e a validação final completa.

## 2026-10-30 10:01:55 -03:00 — Domínio WagerTransaction

**O que foi feito:**

- Criado `src/domain/wager-transaction/wager-transaction.ts` com `WagerTransactionKind`, `WagerTransactionStatus`, `FailureCode`, factories `create`/`rehydrate` e estado encapsulado.
- Implementadas as transições `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED` e `FAILED`, com estados terminais protegidos.
- Implementadas as regras de efeito no saldo, direção do ledger, exigência de referência, payload hash e referências entre transações.
- Criado `test/wager-transaction.test.ts` cobrindo criação, reidratação, todos os tipos, validações, transições, referências, moedas, valores e imutabilidade.
- Atualizados `.docs/decisions.md` com ADR-007 e `ARCHITECTURE.md` com o modelo e as transições.
- Nenhuma persistência, repositório, controller, endpoint, consumidor SQS, Inbox, Outbox ou processamento distribuído foi implementado.

**Decisões e ambiguidades registradas:**

- Referências ausentes não são resolvidas na entidade: a transação pode passar para `PENDING_REFERENCE` e o worker/caso de uso futuro fará a resolução persistente.
- `WIN` pode referenciar `BET` sem igualdade de valor; igualdade de valor é exigida apenas para `REFUND` e `ROLLBACK`, conforme o README.
- A entidade valida uma referência já carregada, mas prevenção de reversão duplicada depende de persistência/constraints futuras.
- `OPENING` foi modelado como tipo interno do domínio, mas não deve ser aceito por API ou fila.
- Foram definidos códigos estáveis, incluindo `REVERSAL_INSUFFICIENT_BALANCE`, distinto de `INSUFFICIENT_BALANCE`.

**Validação e testes:**

- `bun run typecheck` → aprovado.
- `bun test` → aprovado durante a implementação: 32 testes, 0 falhas e 121 expectativas.
- `bun run build` → aprovado.
- `git diff --check` → aprovado, sem erros.

**Pendências:**

- Persistir transações e impor unicidade/idempotência, referências e prevenção de reversões duplicadas no schema SQL em etapa futura.
- Implementar o caso de uso que coordena `WagerTransaction`, Wallet, ledger, Inbox e Outbox em uma transação SQL.

## 2026-10-30 09:51:37 -03:00 — Domínio Wallet e WalletLedgerEntry

**O que foi feito:**

- Criados `src/domain/wallet/wallet.ts` e `src/domain/wallet/wallet-ledger-entry.ts`.
- Implementadas factories privadas `Wallet.open`/`rehydrate` e `WalletLedgerEntry.create`/`rehydrate`.
- Implementadas encapsulação de saldo, versionamento iniciado em `1`, validação de moeda, rejeição de saldo negativo, crédito, débito e retorno explícito do lançamento correspondente.
- Implementado ledger imutável com direções `DEBIT` e `CREDIT`, validação matemática em `create` e consulta `isBalanced`.
- Criados testes abrangentes para criação, movimentações, saldo insuficiente, moedas incompatíveis, versionamento, imutabilidade, reidratação e consistência matemática.
- Atualizados `.docs/decisions.md` com ADR-005 e ADR-006 e `ARCHITECTURE.md` com as decisões do domínio.
- Nenhuma persistência, repositório, endpoint, SQS, Inbox, Outbox ou `WagerTransaction` foi implementado.

**Decisões relevantes:**

- `debit` e `credit` recebem `{ id, transactionId, money, at? }` e retornam o `WalletLedgerEntry` criado; saldo e ledger são validados juntos no domínio.
- A atomicidade entre saldo e ledger será responsabilidade da mesma transação SQL futura, sem simulação por estado em memória.
- A reidratação não recalcula a transição do ledger; datas são copiadas para impedir mutação externa acidental.

**Validação e testes:**

- `bun run typecheck` → aprovado.
- `bun run build` → aprovado.
- `bun test` → aprovado: 22 testes, 0 falhas e 76 expectativas.
- `git diff --check` → aprovado, sem erros.

**Resultado:**

Wallet e WalletLedgerEntry estão implementados e testados, mantendo as invariantes de moeda, não-negatividade, versionamento e consistência do lançamento. A etapa foi encerrada sem iniciar `WagerTransaction`.

**Pendências:**

- Mapear Wallet e ledger para o schema SQL, constraints e repositórios em etapa futura.
- Implementar a transação interna `OPENING` no caso de uso de criação da wallet quando a persistência existir.

## 2026-10-29 17:40:42 -03:00 — Objeto de valor Money

**O que foi feito:**

- Criado `src/domain/money/money.ts`, independente de NestJS, TypeORM, PostgreSQL e SQS.
- Implementada representação interna exata com `bigint` em centavos e moeda como código ISO-4217 de três letras maiúsculas.
- Implementadas factories `from` e `zero`, operações `add`, `subtract` e `negate`, comparações, consultas de sinal e serialização com duas casas decimais.
- Adicionadas validações para strings vazias, formatos malformados, notação científica, `NaN`, `Infinity`, valores negativos de entrada, mais de duas casas e moedas inválidas.
- Criados testes unitários para precisão decimal, valores muito grandes, limites, moedas incompatíveis, imutabilidade e todos os formatos inválidos relevantes.
- Atualizados `.docs/decisions.md` com ADR-004 e `ARCHITECTURE.md` com a decisão de representação monetária.
- Nenhuma wallet, transação, ledger ou regra de aposta foi implementada.

**Por que foi feito:**

Estabelecer uma base monetária exata e imutável antes da implementação dos agregados e casos de uso financeiros, eliminando dependência de aritmética binária de ponto flutuante.

**Como foi feito:**

Strings de entrada são validadas por expressão explícita e convertidas diretamente para centavos com `BigInt`; nenhuma conversão para `number` ocorre. A serialização recompõe a parte inteira e as duas casas fracionárias. Operações retornam novas instâncias e preservam a moeda.

**Validação e testes:**

- Primeira execução de typecheck/build encontrou uma falha de strictness no grupo capturado da regex; uma guarda explícita foi adicionada.
- `bun run typecheck` → aprovado.
- `bun run build` → aprovado.
- `bun test` → aprovado: 14 testes, 0 falhas e 45 expectativas, incluindo todos os testes existentes.
- `git diff --check` → sem erros; apenas avisos informativos de conversão LF/CRLF.

**Resultado:**

`Money` está implementado com precisão decimal exata, saída normalizada em duas casas e cobertura unitária abrangente. A infraestrutura existente não foi alterada.

**Próximos passos:**

Definir o modelo e as invariantes da Wallet antes de criar novas operações financeiras ou persistência de entidades de domínio.

## 2026-10-29 17:09:09 -03:00 — Persistência TypeORM e migrações reversíveis

**O que foi feito:**

- Adicionadas as dependências `@nestjs/config`, `@nestjs/typeorm`, `typeorm` e `pg`.
- Configurada a conexão PostgreSQL por `DATABASE_URL`, com `synchronize: false` e `migrationsRun: false`.
- Integrado o `TypeOrmModule` ao NestJS, com três tentativas de conexão e encerramento estruturado em caso de falha no bootstrap.
- Criado o `DataSource` compartilhado e os comandos Bun `migration:create`, `migration:run` e `migration:revert`.
- Criada a migração mínima reversível `CreateMigrationProbe1710000000000`, contendo somente a tabela técnica `migration_probe`.
- Criado `GET /health/ready`, separado do liveness, verificando PostgreSQL com `SELECT 1` e retornando indisponibilidade quando a consulta falha.
- Adicionados testes para configuração TypeORM e comportamento de readiness; o teste de liveness existente foi preservado.
- Atualizados `.env.example`, `decisions.md` e `ARCHITECTURE.md` com a decisão TypeORM, política de migrações, separação liveness/readiness e limitações observadas.
- Nenhuma entidade financeira, carteira, transação, ledger, inbox, outbox, consumer ou regra de aposta foi implementada.

**Por que foi feito:**

Estabelecer a primeira camada de persistência e um ciclo de migrações controlado e reversível, sem antecipar o schema do domínio financeiro.

**Como foi feito:**

O NestJS inicializa o TypeORM com opções derivadas de `DATABASE_URL`. Os scripts Bun usam o mesmo `DataSource` para aplicar ou desfazer migrações. O readiness consulta a conexão já inicializada, enquanto o liveness continua independente do banco.

**Validação e testes:**

- `bun install` → dependências TypeORM, PostgreSQL e configuração instaladas; lockfile atualizado.
- Primeira rodada de `bun run typecheck`/`bun run build` encontrou incompatibilidades de CommonJS com `import.meta`/top-level await, uma opção de retry no tipo errado e um estreitamento de tipo ausente; todos foram corrigidos.
- `bun run typecheck` → aprovado.
- `bun run build` → aprovado.
- `bun test` → aprovado: 5 testes, 0 falhas e 9 expectativas.
- `docker compose up -d --build` → PostgreSQL, LocalStack e aplicação iniciados; todos ficaram `healthy`.
- `GET /health/live` → HTTP `200`, confirmando liveness independente.
- `GET /health/ready` → HTTP `200` com PostgreSQL `up`.
- Primeira tentativa de `bun run migration:run` no host falhou por conflito com outro PostgreSQL nativo na porta IPv4 5432; o problema foi mantido sem apagar volumes.
- `docker compose exec app bun dist/database/migration-runner.js run` → aplicado com sucesso no PostgreSQL real do Compose.
- Consulta no PostgreSQL confirmou `migration_probe` e `typeorm_migrations` após o apply.
- `docker compose exec app bun dist/database/migration-runner.js revert` → revertido com sucesso.
- Consulta posterior confirmou que `migration_probe` foi removida e que `typeorm_migrations` ficou com zero migrações.
- `bun run migration:create -- TemporaryValidation` → comando validado; o artefato temporário foi removido após o teste.
- `docker compose up -d --build app` após as alterações finais → aplicação reconstruída e iniciada com conexão TypeORM.
- `docker compose down` → concluído; containers e rede removidos, volumes preservados.
- `git diff --check` → sem erros; apenas avisos informativos de conversão LF/CRLF.

**Resultado:**

TypeORM está integrado, a aplicação inicia com PostgreSQL real, a migração mínima pode ser aplicada e revertida, e liveness/readiness possuem responsabilidades distintas. A limitação do PostgreSQL nativo na porta IPv4 do host foi contornada validando os comandos no container da aplicação, sem remover dados.

**Próximos passos:**

Definir o schema do domínio, o mapeamento de `Money`, constraints e estratégia de concorrência antes de criar entidades financeiras ou novas migrações de negócio.

## 2026-10-29 16:35:20 -03:00 — Infraestrutura local com Docker Compose

**O que foi feito:**

- Criado `Dockerfile` multi-stage para compilar e executar a aplicação NestJS com Bun 1.4.4, incluindo health check HTTP.
- Criado `.dockerignore` para excluir dependências, artefatos de build, Git, documentação e arquivos de ambiente da imagem.
- Criado `.env.example` com configurações locais sem segredos reais.
- Criado `docker-compose.yml` com PostgreSQL 16, LocalStack 3.8.1 limitado a SQS e o serviço da aplicação NestJS.
- Configurados health checks para PostgreSQL, LocalStack e aplicação, dependências condicionadas à saúde e volume persistente para os dados do PostgreSQL.
- Criado `docker/localstack/init/ready.d/10-create-sqs.sh` para criar `wager-transactions-dlq.fifo` e `wager-transactions.fifo`, ambas FIFO, associando a fila principal à DLQ com `maxReceiveCount=5`.
- Nenhuma entidade, carteira, transação financeira, consumer, inbox, outbox ou regra de negócio foi implementada.

**Por que foi feito:**

Disponibilizar somente o ambiente local reproduzível exigido pelo desafio, permitindo iniciar e encerrar PostgreSQL, LocalStack/SQS e a aplicação sem antecipar a implementação do domínio.

**Como foi feito:**

O Compose usa imagens oficiais fixadas por tag, injeta configurações por variáveis com defaults locais e monta o script de inicialização do LocalStack. A aplicação recebe `DATABASE_URL`, endpoint SQS e nomes das filas, mas não tenta acessá-los porque essas dependências ainda não existem no código.

**Validação e testes:**

- `docker compose config` e `docker compose config --quiet` → configuração válida.
- `docker compose up -d --build` → concluído; imagens PostgreSQL, LocalStack e Bun baixadas, imagem da aplicação construída e três containers iniciados.
- Primeira validação encontrou apenas a DLQ; os logs mostraram erro de parsing do argumento `--attributes` na criação da fila principal.
- Corrigido o script para enviar os atributos da fila principal como JSON completo.
- `docker compose up -d --force-recreate localstack` → concluído após a correção.
- `docker compose ps` → PostgreSQL, LocalStack e aplicação `healthy`.
- `awslocal sqs list-queues` → listou `wager-transactions-dlq.fifo` e `wager-transactions.fifo`.
- `awslocal sqs get-queue-attributes` → confirmou `FifoQueue=true` e `RedrivePolicy` apontando para a DLQ com `maxReceiveCount=5`.
- `curl.exe http://127.0.0.1:3000/health/live` → HTTP `200`, corpo `{ "status":"ok" }`.
- `docker compose down` → concluído; containers e rede removidos, volumes `backend-challenge_postgres-data` e `backend-challenge_localstack-data` preservados.
- `bun run typecheck` → aprovado.
- `bun run build` → aprovado.
- `bun test` → aprovado: 1 teste, 0 falhas.
- `git diff --check` → sem erros.

**Resultado:**

O ambiente local foi iniciado, validado e encerrado com sucesso. A aplicação mantém apenas o endpoint de liveness existente; nenhum componente do domínio foi iniciado.

**Próximos passos:**

Decidir e documentar ORM, migrations, schema, concorrência e idempotência antes de configurar persistência ou implementar o domínio.

## 2026-10-29 16:16:46 -03:00 — Estrutura inicial NestJS com Bun

**O que foi feito:**

- Criada a estrutura inicial da aplicação NestJS em `src/`, com `AppModule`, `HealthController` e bootstrap HTTP.
- Criado o endpoint aberto `GET /health/live`, retornando `{ "status": "ok" }`.
- Configurado TypeScript strict em `tsconfig.json` e `tsconfig.build.json`, com decorators necessários ao NestJS.
- Criados `package.json` e `bun.lock` com scripts de desenvolvimento, build, typecheck e testes usando Bun.
- Criado um teste unitário mínimo para o controller em `test/health.controller.test.ts`.
- Nenhum arquivo de documentação existente foi sobrescrito ou removido; banco, ORM, SQS, LocalStack, regras financeiras, carteiras e processamento de transações continuam fora desta etapa.

**Por que foi feito:**

Estabelecer somente a base executável e verificável do serviço, conforme o escopo desta etapa, mantendo as restrições de Bun, NestJS, TypeScript estrito e sem Prisma.

**Como foi feito:**

Foi usado o adaptador HTTP padrão do NestJS (`@nestjs/platform-express`) e o runner nativo `bun test`. O compilador TypeScript gera `dist/`; `@types/bun` foi incluído para que os testes que importam `bun:test` também participem do typecheck estrito.

**Validação e testes:**

- `bun --version` → `1.4.4`.
- Primeira tentativa de `bun install` falhou com `ConnectionRefused` ao acessar o registro; a instalação foi repetida com acesso de rede autorizado e terminou com 98 pacotes instalados.
- A primeira tentativa de `bun run typecheck` falhou porque faltava a tipagem de `bun:test`; após adicionar `@types/bun`, o typecheck passou.
- `bun install` após a correção → concluído, lockfile atualizado.
- `bun run typecheck` → aprovado.
- `bun run build` → aprovado.
- `bun test` → aprovado: 1 teste, 1 pass, 0 fail.
- `bun run start` com o artefato compilado registrou a rota `GET /health/live`; `curl.exe http://127.0.0.1:3000/health/live` retornou HTTP `200` e `{ "status":"ok" }`.
- `git diff --check` → aprovado; o status final contém somente os novos arquivos da aplicação e configuração.

**Resultado:**

A aplicação NestJS mínima compila, passa pelo typecheck estrito, executa o teste nativo do Bun e responde ao health check de liveness. Não foram iniciadas configurações de PostgreSQL ou LocalStack.

**Próximos passos:**

Definir e registrar as decisões pendentes de persistência, concorrência, idempotência e processamento assíncrono antes de implementar o domínio, migrations, PostgreSQL ou SQS.

## 2026-10-29 15:37 -03:00 — Correção da metodologia do diário de progresso

**O que foi feito:**

- Revisado o conteúdo anterior de `.docs/progress.md`.
- Reorganizado o arquivo para que novas atividades sejam registradas no início, em ordem cronológica reversa, sem substituir o histórico.
- Preservado, ao final, o conteúdo histórico existente, cuja data e horário não estavam registrados.
- Atualizado `.docs/ai-workflow.md` para tornar obrigatório o registro incremental ao final de cada etapa relevante.

**Por que foi feito:**

Atender à regra de que `progress.md` seja um diário cumulativo das atividades realizadas, especialmente das alterações feitas pela IA, mantendo rastreabilidade e evitando que um resumo do estado atual substitua o histórico.

**Como foi feito:**

Foi criada uma entrada no formato definido para esta atividade. O registro histórico anterior foi mantido como seção separada, sem atribuir a ele uma data ou horário não confirmados. A metodologia de IA passou a exigir uma nova entrada no início do arquivo após cada etapa relevante, incluindo falhas e validações.

**Validação e testes:**

- Executado `Get-Date -Format 'yyyy-MM-dd HH:mm:ss K'`; horário observado: `2026-10-29 15:37:15 -03:00`.
- Lidos `.docs/progress.md` e `.docs/ai-workflow.md` antes da alteração.
- Verificada a ausência de `AGENTS.md` no repositório.
- Não foram executados testes da aplicação, banco, filas ou concorrência; esta tarefa altera somente documentação.

**Resultado:**

O diário incremental e a regra metodológica foram atualizados. A implementação da aplicação continua não iniciada. O histórico anterior foi preservado sem data inventada.

**Próximos passos:**

Registrar cada nova etapa relevante no início deste arquivo antes de encerrar a etapa, incluindo arquivos afetados, validações reais e pendências.
