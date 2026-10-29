# Diário de progresso

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

