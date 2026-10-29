# Diário de progresso

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

