# Registro de decisões arquiteturais

## Convenção

Status possíveis: **proposta**, **aprovada** e **substituída**. O [README](../README.md) é a fonte dos requisitos; [challenge.md](challenge.md) é sua cópia fiel.

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
