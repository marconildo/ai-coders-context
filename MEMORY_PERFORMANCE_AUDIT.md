# Auditoria de memória e performance do dotcontext

Data da investigação: 2026-07-11  
Revisão analisada: b9e2981  
Branch: fix/performance-issues  
Ambiente de medição: Node.js v22.20.0, npm 10.9.3, Linux

## Resumo executivo

A investigação confirmou falhas capazes de explicar tanto crescimento progressivo de memória e disco quanto picos abruptos de RSS e degradação de performance.

O principal problema é um encadeamento entre hooks, persistência e leitura do runtime:

1. Hooks de Write e Edit recebem o conteúdo integral da operação.
2. O dispatcher materializa todo o stdin em memória.
3. O conteúdo integral de tool_input é persistido em trace.jsonl.
4. Não há rotação, retenção, paginação ou limite de tamanho para traces.
5. Operações de qualidade, replay e dataset relêem e parseiam o histórico inteiro.
6. Replay preserva todos os traces mesmo quando maxEvents é pequeno.
7. A camada MCP serializa respostas grandes e depois faz JSON.parse do texto completo apenas para logging.

Há ainda dois problemas independentes com alto potencial de impacto:

- sensores e acceptance runners acumulam stdout e stderr completos em memória;
- falhas de inicialização ou shutdown do LSP deixam processos filhos vivos.

Conclusão: os relatos de usuários são tecnicamente plausíveis e foram reproduzidos em cenários isolados. A prioridade deve ser introduzir limites rígidos e streaming antes de otimizações menores.

## Classificação dos achados

| ID | Severidade | Confiança | Área | Resumo |
| --- | --- | --- | --- | --- |
| F-01 | Crítica | Confirmado por medição | Harness / sensores | stdout e stderr de subprocessos crescem sem limite |
| F-02 | Crítica | Confirmado por medição | Hooks / runtime state | hooks persistem payloads completos e traces não têm retenção |
| F-03 | Crítica | Confirmado por medição | Runtime / replay / dataset | históricos são materializados integralmente; maxEvents não limita o payload do replay |
| F-04 | Crítica quando useLSP=true | Confirmado por reprodução | Semantic / LSP | processos LSP ficam órfãos após falha de inicialização ou shutdown |
| F-05 | Alta | Confirmado por inspeção | Context init / semantic | inicialização semântica repete scans e análises completas |
| F-06 | Alta | Confirmado por inspeção | MCP / listagens | respostas e coleções grandes são duplicadas e não paginadas |
| F-07 | Média | Confirmado por inspeção | Caches / lifecycle | caches e índices não têm limite global ou invalidação completa |

## Escopo e método

Foram auditadas as quatro superfícies da arquitetura:

- CLI e hook dispatch;
- harness, incluindo runtime state, sensores, replay, datasets e context;
- gateway e servidor MCP;
- integrações Claude Code, Codex e Pi.

O método combinou:

- busca estática por buffers, arrays, Maps, subprocessos, listeners, leituras integrais e Promise.all;
- rastreamento dos fluxos de hooks e runtime;
- medições isoladas de RSS com Node.js;
- reprodução controlada de falha LSP;
- inspeção agregada do runtime local, sem expor conteúdo;
- build e suíte completa de testes.

Os benchmarks abaixo são sintéticos e servem para demonstrar a forma de crescimento. Os números absolutos variam por sistema, versão do Node e formato dos dados.

## Evidência quantitativa

| Cenário | Entrada | Resultado observado |
| --- | ---: | --- |
| Sensor runShell | 80 MiB em stdout | RSS de aproximadamente 45 MiB para 293 MiB; 80 MiB permaneceram na string retornada |
| Acceptance runner | 80 MiB em stdout | RSS de aproximadamente 45 MiB para 133 MiB, embora apenas 8 KiB sejam retornados |
| listTraces | JSONL de 50,3 MB, 100 mil eventos | RSS após leitura de aproximadamente 231 MiB; heap usado de 113 MiB |
| buildReplay com maxEvents=10 | mesmos 100 mil traces | 10 events, mas 100 mil traces no resultado; RSS de aproximadamente 304 MiB |
| Hook Write | content de 5 MiB | trace.jsonl cresceu para 5.243.340 bytes e reteve o conteúdo |
| LSP com initialize rejeitado | duas tentativas | dois processos filhos vivos; shutdown deixou os dois vivos |

O runtime deste checkout também confirma o comportamento em uso normal:

- 33 arquivos de trace;
- 1.387 eventos;
- 1.065.603 bytes de traces;
- 1.245 eventos tool.use;
- 77 eventos com tool_input.content;
- 361.957 bytes de conteúdo de Write/Edit duplicados nos traces;
- 29 bindings em host-sessions.json.

Esse volume local ainda é pequeno, mas demonstra que o caminho de retenção está ativo.

## F-01 — Captura ilimitada de stdout e stderr

### Evidência

O helper de sensores mantém cada chunk em arrays e, ao final, concatena tudo e converte para string:

- [testsPassing.ts](src/harness/adapters/out/sensors/testsPassing.ts), linhas 94–115.

O helper é reutilizado por tests-passing e typecheck-clean. Em modo Jest, o stdout completo é adicionalmente parseado como JSON.

O acceptance runner tem uma constante de tail de 8 KiB, mas só aplica o corte depois de acumular e concatenar a saída completa:

- [acceptanceRunner.ts](src/harness/domain/workflow/plans/acceptanceRunner.ts), linhas 88–104.

### Impacto

- pico de memória proporcional à saída total do filho;
- múltiplas cópias simultâneas: chunks, Buffer concatenado e string UTF-16;
- OOM em testes verbosos, typecheck com muitos erros ou comandos que imprimem artefatos;
- timeout não limita memória produzida antes do encerramento.

### Correção recomendada

1. Implementar um ring buffer de bytes para stderr e para modos que só precisam de tail.
2. Definir limite absoluto de captura, por exemplo 8–16 MiB, e matar o filho ou truncar explicitamente ao excedê-lo.
3. Para Jest, usar arquivo temporário via --outputFile ou parser incremental; não manter JSON e chunks duplicados.
4. Aplicar backpressure ou descartar chunks antigos durante a execução, não apenas no finish.
5. Incluir bytesCaptured, bytesDropped e outputTruncated no resultado.

## F-02 — Hooks persistem payload completo e traces crescem indefinidamente

### Evidência

O dispatcher lê stdin inteiro em chunks, concatena e cria uma string antes do JSON.parse:

- [hookDispatchService.ts](src/cli/services/hookDispatchService.ts), linhas 280–287.

O mapper inclui tool_input sem sanitização ou limite:

- [bashClassification.ts](src/harness/application/hooks/bashClassification.ts), linhas 95–106.

O trace é serializado integralmente e anexado ao JSONL:

- [runtimeStateService.ts](src/harness/adapters/out/runtimeState/runtimeStateService.ts), linhas 185–197.

Os templates ativam PostToolUse para Write, Edit e Bash. Write pode carregar o arquivo inteiro em content; Edit pode carregar blocos extensos.

Não foi encontrado mecanismo de:

- limite do stdin do hook;
- limite por campo ou evento;
- redaction do conteúdo de Write/Edit;
- rotação de trace.jsonl;
- quota por sessão ou repositório;
- expiração ou remoção de sessões.

### Impacto

- cópias transitórias grandes no processo curto do hook;
- crescimento linear de disco por edição;
- dados de código e possíveis segredos ficam duplicados em .context/runtime;
- cada leitura posterior do trace amplifica o custo;
- hooks frequentes adicionam I/O síncrono percebido pelo host.

### Correção recomendada

1. Persistir apenas metadados de Write/Edit: caminho, tamanho, hash, faixa alterada e classificação.
2. Remover content, old_string, new_string e campos equivalentes, ou truncá-los para uma amostra pequena configurável.
3. Rejeitar ou truncar stdin acima de um limite explícito antes de Buffer.concat.
4. Introduzir rotação por bytes e idade, com retenção total por repositório.
5. Adicionar comando de prune e execução automática segura no início/fim de sessão.
6. Tornar a política de captura documentada e configurável, com default seguro.

## F-03 — listTraces, replay e dataset materializam todo o histórico

### Evidência

listTraces executa readFile do JSONL completo, split, trim e JSON.parse de todas as linhas:

- [runtimeStateService.ts](src/harness/adapters/out/runtimeState/runtimeStateService.ts), linhas 334–352.

O mesmo padrão de coleção integral existe em listSessions e listArtifacts:

- [runtimeStateService.ts](src/harness/adapters/out/runtimeState/runtimeStateService.ts), linhas 233–250 e 314–331.

Leituras integrais de traces também acontecem em rotas frequentes:

- avaliação de task em [taskContractsService.ts](src/harness/application/contracts/taskContractsService.ts), linhas 380–391;
- consulta de sensor runs em [sensorsService.ts](src/harness/application/sensors/sensorsService.ts), linhas 125–129.

Replay carrega traces, artefatos, checkpoints, sensores, tasks e handoffs em paralelo, cria uma segunda coleção de events e só então aplica maxEvents:

- [replayService.ts](src/harness/application/replay/replayService.ts), linhas 133–251.

Depois do corte, o objeto retornado ainda inclui traces, artifacts, checkpoints, sensorRuns, tasks e handoffs completos:

- [replayService.ts](src/harness/application/replay/replayService.ts), linhas 252–269.

listReplays carrega todos os arquivos JSON em Promise.all:

- [replayService.ts](src/harness/application/replay/replayService.ts), linhas 283–296.

Dataset seleciona todas as sessões não concluídas por default e constrói todos os replays em Promise.all:

- [datasetService.ts](src/harness/application/datasets/datasetService.ts), linhas 253–286.

listDatasets também carrega todos os datasets em Promise.all:

- [datasetService.ts](src/harness/application/datasets/datasetService.ts), linhas 290–299.

### Impacto

- crescimento de memória muito maior que o tamanho do arquivo em disco;
- maxEvents transmite uma falsa sensação de proteção;
- replay duplica o histórico em memória e novamente em disco;
- buildDataset multiplica o pico pelo número de sessões concorrentes;
- avaliações simples ficam progressivamente mais lentas conforme a sessão cresce.

### Correção recomendada

1. Substituir listTraces por leitura streaming de JSONL com cursor, limit, direction e filtros por event/level/time.
2. Manter um índice resumido dos últimos sensor runs por sensor, evitando scan completo na avaliação.
3. Fazer maxEvents limitar leitura, transformação e payload final.
4. No replay parcial, não incluir coleções completas; retornar summaries e cursores.
5. Processar datasets com concorrência limitada, idealmente uma sessão por vez.
6. Paginar listSessions, listArtifacts, listReplays e listDatasets; listar metadados sem carregar payloads.
7. Definir tamanho máximo para artefato, checkpoint.data, trace.data e arquivos de replay/dataset.

## F-04 — Processos LSP órfãos

### Evidência

ensureServer registra o processo no Map e aguarda initialize:

- [lspLayer.ts](src/harness/adapters/out/semantic/lsp/lspLayer.ts), linhas 69–143.

Se initialize falha ou expira, o catch apenas retorna false:

- [lspLayer.ts](src/harness/adapters/out/semantic/lsp/lspLayer.ts), linhas 144–147.

O processo não é morto. Uma nova tentativa cria outro processo e sobrescreve a entrada do Map. O processo anterior fica vivo e deixa de ser alcançável pelo gerenciador.

cleanup remove Maps e rejeita requests, mas não encerra o processo:

- [lspLayer.ts](src/harness/adapters/out/semantic/lsp/lspLayer.ts), linhas 236–246.

shutdown envia shutdown/exit, porém, se houver erro ou timeout, apenas chama cleanup:

- [lspLayer.ts](src/harness/adapters/out/semantic/lsp/lspLayer.ts), linhas 399–416.

A reprodução com um servidor que rejeita initialize deixou um filho por tentativa e nenhum foi eliminado por shutdown.

### Impacto

- múltiplos language servers acumulam memória e CPU;
- processos órfãos podem sobreviver ao fluxo semântico;
- enhanceWithLSP pode repetir ensureServer para até 100 símbolos;
- falha silenciosa torna o diagnóstico difícil.

### Correção recomendada

1. Guardar uma Promise de inicialização por linguagem para deduplicar tentativas.
2. Em qualquer falha de initialize, fechar stdin, enviar SIGTERM e aplicar SIGKILL após grace period.
3. Em shutdown, sempre garantir término do processo e aguardar exit.
4. Associar pendingRequests à linguagem; hoje cleanup de uma linguagem rejeita todos os requests globais.
5. Adicionar circuit breaker após uma falha por linguagem/projeto durante a análise atual.
6. Criar testes que verificam contagem de filhos após initialize rejeitado, timeout e shutdown.

## F-05 — Context init repete scans e análises semânticas

### Evidência

context init usa por default type=both e semantic=true:

- [contextTools.ts](src/harness/application/context/contextTools.ts), linhas 589–601.

Primeiro, FileMapper globba e mantém a estrutura inteira do repositório:

- [fileMapper.ts](src/utils/fileMapper.ts), linhas 47–119.

Depois:

- DocumentationGenerator cria um CodebaseAnalyzer, calcula fingerprint e analisa o repositório: [documentationGenerator.ts](src/harness/application/context/scaffolding/generators/documentation/documentationGenerator.ts), linhas 75–85.
- A escrita do snapshot cria outro analyzer se functionalPatterns não foi fornecido: [semanticSnapshotService.ts](src/harness/adapters/out/semantic/semanticSnapshotService.ts), linhas 415–435.
- AgentGenerator cria outro CodebaseAnalyzer e analisa novamente: [agentGenerator.ts](src/harness/application/context/scaffolding/generators/agents/agentGenerator.ts), linhas 118–125.

O orquestrador chama docs e agents separadamente com semantic habilitado:

- [contextTools.ts](src/harness/application/context/contextTools.ts), linhas 669–721.

Uma análise aceita até 5.000 arquivos e guarda FileAnalysis, símbolos e grafos:

- [codebaseAnalyzer.ts](src/harness/adapters/out/semantic/codebaseAnalyzer.ts), linhas 32–38 e 56–131.

O refresh de snapshot calcula fingerprint até três vezes por tentativa e pode repetir a tentativa três vezes:

- [semanticSnapshotService.ts](src/harness/adapters/out/semantic/semanticSnapshotService.ts), linhas 307–338.

Cada fingerprint começa com glob de todo o repositório e lê o conteúdo integral de cada arquivo relevante:

- [semanticSnapshotService.ts](src/harness/adapters/out/semantic/semanticSnapshotService.ts), linhas 732–756.

### Impacto

- context init faz aproximadamente três análises semânticas completas no caminho default;
- grandes monorepos sofrem alta latência, I/O e pressão de GC;
- fingerprint pode ler o codebase várias vezes;
- o glob inicial coleta caminhos que só são filtrados depois.

### Correção recomendada

1. Criar um único AnalysisBundle por operação contendo RepoStructure, SemanticContext, functionalPatterns, stackInfo e fingerprint.
2. Injetar o bundle em DocumentationGenerator, AgentGenerator e SemanticSnapshotService.
3. Fazer fingerprint incremental com stat/mtime/size e hash de conteúdo apenas quando necessário, ou usar git tree/index quando disponível.
4. Usar um único glob por conjunto de extensões, deduplicado e com ignores centralizados.
5. Permitir maxFiles e limites de bytes configuráveis no init; avisar quando a análise for parcial.
6. Instrumentar duração, arquivos e bytes lidos por estágio.

## F-06 — Respostas MCP e listagens sem paginação amplificam o pico

### Evidência

createJsonResponse serializa o objeto inteiro para uma string formatada:

- [response.ts](src/mcp/gateway/response.ts), linhas 27–33.

Após a serialização, logToolResponse faz JSON.parse do texto completo para extrair poucas chaves:

- [mcpServer.ts](src/mcp/server/mcpServer.ts), linhas 1046–1058 e 1090–1098.

Assim, respostas como listTraces, replay, listReplays e datasets mantêm simultaneamente:

- estruturas do harness;
- string JSON formatada;
- objeto parseado novamente pelo logger.

O schema MCP aceita content, data, output e maxEvents sem limites de tamanho e expõe listagens sem cursor:

- [mcpServer.ts](src/mcp/server/mcpServer.ts), linhas 680–715.

### Impacto

- picos adicionais de heap em respostas grandes;
- maior tempo de CPU em stringify/parse redundante;
- payloads MCP podem exceder limites do cliente antes de o servidor se recuperar;
- pretty-print adiciona custo sem benefício operacional para payloads grandes.

### Correção recomendada

1. Propagar success/error/resultSummary como metadados estruturados antes da serialização.
2. Remover parseResponsePayload do caminho de logging.
3. Paginar todas as listagens e estabelecer um limite default conservador.
4. Rejeitar parâmetros acima do máximo no schema Zod.
5. Não usar pretty-print em respostas grandes.
6. Retornar referências a artefatos/arquivos em vez de conteúdo integral quando apropriado.

## F-07 — Caches e índices sem lifecycle completo

### Evidência

O cache global de sessões MCP é um Map sem máximo ou TTL:

- [actionLogger.ts](src/mcp/logging/actionLogger.ts), linha 42 e linhas 107–139.

O ContextCache só remove entradas expiradas quando a mesma chave é consultada. Entradas nunca revisitadas permanecem:

- [contextCache.ts](src/harness/adapters/out/semantic/contextCache.ts), linhas 39–95.

SemanticContextBuilder mantém o SemanticContext completo indefinidamente para o mesmo path e não invalida por mudança de arquivos:

- [contextBuilder.ts](src/harness/adapters/out/semantic/contextBuilder.ts), linhas 45–66.

Existe cacheEnabled nas opções do analyzer, mas não há uso dessa flag no código de cache.

host-sessions.json guarda bindings sem expiração e é lido integralmente em cada lookup:

- [hookSessionStore.ts](src/integrations/shared/hookSessionStore.ts), linhas 45–83.

checkpoints ficam embutidos em session.json, crescem sem limite e o arquivo completo é reescrito a cada trace:

- [runtimeStateService.ts](src/harness/adapters/out/runtimeState/runtimeStateService.ts), linhas 190–197 e 355–373.

### Impacto

- degradação gradual em servidores MCP usados com muitos repositórios;
- contexto semântico pode ficar obsoleto enquanto continua retido;
- host-sessions.json e session.json tornam-se documentos cada vez mais caros;
- o custo de appendTrace cresce com o tamanho de session.json quando há muitos checkpoints.

### Correção recomendada

1. Aplicar LRU com limites por quantidade e bytes.
2. Limpar caches no stop e invalidá-los por fingerprint/mtime.
3. Honrar cacheEnabled.
4. Expirar bindings encerrados e particionar o store por host/session ou usar arquivos individuais.
5. Mover checkpoints para JSONL ou arquivos individuais e manter apenas resumo no session.json.

## Plano de correção priorizado

### P0 — Contenção imediata

1. Limitar captura de stdout/stderr durante a execução.
2. Redigir/truncar payloads de Write/Edit antes de appendTrace.
3. Implementar leitura paginada/streaming de traces.
4. Corrigir maxEvents para limitar o replay inteiro.
5. Encerrar processos LSP em todos os caminhos de falha.
6. Aplicar limites de schema para content, data, output, maxEvents e listagens.

Essas mudanças atacam diretamente os caminhos capazes de causar OOM.

### P1 — Evitar crescimento progressivo

1. Rotação e retenção de runtime state.
2. Paginação de sessions, artifacts, replays e datasets.
3. Dataset com concorrência limitada.
4. Remoção do JSON.parse redundante no logging MCP.
5. Índice incremental de sensores e eventos recentes.
6. Prune de host session bindings e checkpoints.

### P2 — Reduzir custo semântico

1. Compartilhar um AnalysisBundle no context init.
2. Tornar fingerprint incremental.
3. LRU e invalidação correta dos caches.
4. Unificar globs e ignores.
5. Expor telemetria de duração, bytes e contagem de arquivos.

## Testes de regressão necessários

Adicionar testes que falhem antes da correção:

1. subprocesso produz 100 MiB; RSS e bytes retidos permanecem abaixo de um teto;
2. hook Write com content grande persiste apenas metadados/truncamento;
3. stdin do hook acima do limite é truncado ou rejeitado sem crash;
4. listTraces retorna no máximo limit e fornece cursor;
5. replay maxEvents=10 não contém arrays completos fora dos 10 eventos;
6. buildDataset respeita limite de concorrência;
7. listReplays/listDatasets não lê payload de todos os arquivos;
8. LSP initialize rejeitado ou expirado deixa zero filhos;
9. shutdown LSP deixa zero filhos mesmo quando o protocolo não responde;
10. context init analisa cada arquivo uma única vez por operação;
11. caches respeitam máximo, TTL e cacheEnabled;
12. retenção remove traces, sessions e bindings antigos sem quebrar sessões ativas.

Os testes de memória devem rodar em uma faixa tolerante e medir invariantes de bytes retidos, não apenas um RSS absoluto frágil.

## Observabilidade recomendada

Sem logs de conteúdo, registrar:

- process.memoryUsage antes/depois de operações pesadas;
- bytes lidos, parseados, serializados e descartados;
- tamanho por trace e tamanho acumulado da sessão;
- número de sessions, replays, datasets e bindings;
- subprocess output bytes e truncation;
- PIDs LSP, estado de inicialização, tentativas e motivo de término;
- duração por estágio do context init;
- cache entries e bytes estimados.

Criar alertas locais quando:

- um evento de trace ultrapassar 256 KiB;
- uma sessão ultrapassar a quota configurada;
- um subprocesso truncar saída;
- um replay/dataset precisar ser parcial;
- um LSP exigir SIGKILL.

## Workaround operacional até a correção

Para usuários afetados:

1. desabilitar temporariamente PostToolUse de Write/Edit, mantendo SessionStart e Stop se necessários;
2. evitar replaySession, listTraces, listReplays, buildDataset e listDatasets em sessões grandes;
3. iniciar sessões novas com maior frequência;
4. remover ou arquivar manualmente .context/runtime antigo somente com backup e fora de uma sessão ativa;
5. evitar useLSP=true;
6. configurar testes e typecheck para reduzir output.

Não é recomendado apenas aumentar --max-old-space-size: isso adia o OOM, mas não corrige crescimento de disco, processos órfãos nem complexidade das leituras.

## Validação da baseline

Nenhuma alteração de runtime foi feita nesta investigação.

Validações executadas:

- npm run build: aprovado;
- npm test -- --runInBand: 92 suítes aprovadas, 564 testes aprovados, 0 falhas.

Isso indica que a suíte funcional atual não cobre os limites e cenários de carga descritos. Os achados são problemas de comportamento sob volume e lifecycle, não falhas detectadas pelos testes existentes.

## Especificações de correção

As propostas implementáveis, critérios de aceitação e skills preventivas estão indexados em [specs/performance/README.md](specs/performance/README.md).

## Limitações

- Não foram coletados heap snapshots ou perfis de produção de usuários.
- As medições foram isoladas no checkout local e não representam um workload específico de cliente.
- A auditoria não alterou o código nem validou uma implementação de correção.
- Dependências externas, especialmente o SDK MCP e implementações reais de language server, podem adicionar overhead além do observado.

Mesmo com essas limitações, F-01 a F-04 têm reprodução direta e suficiente para justificar correção imediata.
