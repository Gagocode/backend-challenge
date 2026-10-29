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
