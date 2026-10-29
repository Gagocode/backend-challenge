# Desenvolvimento assistido por IA

A IA será ferramenta de apoio à análise, implementação, testes, revisão e documentação. A validação técnica, a responsabilidade pelas decisões e a capacidade de explicar o resultado permanecem com o desenvolvedor.

## Metodologia

1. Consultar o README oficial e documentos de contexto antes de cada etapa.
2. Trabalhar em incrementos pequenos e verificáveis.
3. Planejar antes de implementar.
4. Usar prompts específicos, com escopo e critérios de aceitação.
5. Revisar alterações e diffs gerados pela IA.
6. Executar testes e verificar resultados reais.
7. Não aceitar afirmações de sucesso sem evidências.
8. Ao final de cada etapa relevante, atualizar `progress.md` com uma nova entrada no início do arquivo, preservando todas as entradas anteriores.
9. Registrar no diário arquivos criados, modificados ou removidos, motivação, abordagem, validações, resultados e próximos passos.
10. Registrar também tentativas que falharem, erros observados e ações necessárias para correção; não marcar como concluído o que foi apenas planejado.
11. Registrar decisões em `decisions.md` e consolidá-las em `ARCHITECTURE.md`.
12. Registrar limitações, falhas e correções relevantes.
13. Usar Git para controlar alterações e permitir reversões.
14. Garantir que o responsável compreenda e consiga explicar o código produzido.

## Critério de encerramento de cada etapa

Uma etapa só deve ser encerrada depois de revisar o diff, executar as verificações adequadas, registrar resultados reais e inserir a entrada correspondente no início de `.docs/progress.md`. O horário deve ser o horário local observado no ambiente, com o fuso indicado quando conhecido; se não puder ser confirmado, a entrada deve declarar essa ausência em vez de inventar um timestamp.

Antes de qualquer mudança, o escopo oficial deve ser conferido. Sugestões que não forem exigências do desafio são propostas até revisão e registro. O histórico do progresso é cumulativo e não pode ser substituído por um resumo atualizado.
