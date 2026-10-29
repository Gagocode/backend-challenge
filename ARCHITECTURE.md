# Arquitetura

## Estado e convenções

| Categoria | Estado |
|---|---|
| Requisitos do desafio | Definidos no [README.md](README.md) e copiados fielmente em [.docs/challenge.md](.docs/challenge.md). |
| Propostas arquiteturais | Hipóteses abaixo, ainda não aprovadas nem implementadas. |
| Decisões aprovadas | Apenas a preservação do README como fonte de verdade e esta separação documental. |
| Funcionalidades implementadas e validadas | Nenhuma. |

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
| Casos de uso/domínio | Regras, Money, Wallet, transação, ledger e idempotência. | Não implementado |
| PostgreSQL | Estado, constraints, índices, inbox e outbox. | Não configurado |
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

## Decisões pendentes

- ORM, schema, migrations e mapeamento de Money.
- Concorrência por wallet e retry de conflitos.
- Idempotência, JSON canônico e payload hash.
- Processamento HTTP síncrono versus assíncrono e status HTTP.
- Tentativas, backoff, visibilidade, DLQ e shutdown da SQS.
- TTL/reprocessamento de referências ausentes.
- Claim/lock e retry de publishers concorrentes da outbox.
- Failure codes, autenticação/IdP, OpenAPI e instrumentação.

## Limitações conhecidas

Não há aplicação, banco, filas, migrations, infraestrutura, endpoints, autenticação, testes ou validações implementadas.
