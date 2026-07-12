export type Locale = 'en' | 'pt-BR';

export const SUPPORTED_LOCALES: Locale[] = ['en', 'pt-BR'];
export const DEFAULT_LOCALE: Locale = 'en';

const englishMessages = {
  'cli.description': 'Sync .context assets, reverse-sync tool state, and install MCP integrations for your repository',
  'global.options.lang': 'Language for CLI output (en or pt-BR)',
  'ui.projectConfiguration.title': 'Project Configuration',
  'ui.projectConfiguration.repository': 'Repository',
  'ui.projectConfiguration.output': 'Output',
  'ui.projectConfiguration.mode': 'Mode',
  'ui.progress.starting': 'Starting...',
  'ui.analysis.complete.title': 'Analysis Complete',
  'ui.analysis.files': 'Files',
  'ui.analysis.directories': 'Directories',
  'ui.analysis.totalSize': 'Total Size',
  'ui.fileTypeDistribution.title': 'File Type Distribution',
  'ui.generationSummary.title': 'Scaffold Complete',
  'ui.generationSummary.documentation': 'Documentation',
  'ui.generationSummary.agents': 'Agents',
  'ui.generationSummary.skills': 'Skills',
  'ui.generationSummary.timeElapsed': 'Time',
  'ui.generationSummary.nextStep': 'Next step: customize the generated templates to match your project.',
  'ui.error.title': 'Error',
  'ui.splash.directoryLabel': 'directory',
  'info.update.available.title': 'Update available',
  'info.update.available.detail': 'A newer version {latest} is available (current {current}). Update with {command}.',
  'commands.fill.options.verbose': 'Enable verbose logging',
  'errors.cli.executionFailed': 'CLI execution failed',
  'prompts.main.action': 'What would you like to do?',
  'prompts.main.choice.exit': 'Exit interactive mode',
  'prompts.language.select': 'Choose the CLI language / Escolha o idioma do CLI',
  'prompts.language.option.en': 'English / Inglês',
  'prompts.language.option.pt-BR': 'Portuguese (Brazil) / Português (Brasil)',
  'success.interactive.goodbye': 'Goodbye! Thanks for using dotcontext.',
  'commands.sync.description': 'Sync agent playbooks to AI tool directories (.claude, .github, etc.)',
  'commands.sync.options.source': 'Source agents directory',
  'commands.sync.options.target': 'Target directories to sync to',
  'commands.sync.options.mode': 'Reference type: symlink or markdown',
  'commands.sync.options.preset': 'Built-in preset: claude, github, cursor, or all',
  'commands.sync.options.force': 'Overwrite existing files/symlinks',
  'commands.sync.options.dryRun': 'Preview changes without writing',
  'commands.sync.options.verbose': 'Enable verbose logging',
  'prompts.main.choice.viewPending': 'View pending files',
  'prompts.main.unfilledPrompt': '{count} files still need content. What would you like to do?',
  'prompts.main.pendingFilesHeader': 'Files pending content:',
  'errors.sync.failed': 'Failed to sync agents',
  'errors.sync.noTargetsSpecified': 'No targets specified. Use --target or --preset.',
  'errors.sync.sourceMissing': 'Source directory does not exist: {path}',
  'errors.sync.sourceNotDirectory': 'Source path is not a directory: {path}',
  'warnings.sync.noAgentsFound': 'No agent files found in source directory.',
  'spinner.sync.processing': 'Syncing to {path}...',
  'spinner.sync.complete': 'Synced {count} files to {path}',
  'spinner.sync.failed': 'Failed to sync to {path}',
  'success.sync.completed': 'Agent sync complete. Your AI tools are now configured.',
  'steps.sync.processingTarget': 'Processing target: {path}',
  'steps.sync.summary': 'Generating sync summary',
  'info.sync.foundAgents': 'Agent files discovered',
  'info.sync.foundAgentsDetail': 'Found {count} agent playbooks to sync',
  // Import commands translations
  'commands.importRules.description': 'Import cursor rules and AI assistant rules to .context/docs',
  'commands.importRules.options.source': 'Source paths to scan for rules',
  'commands.importRules.options.target': 'Target directory for imported rules',
  'commands.importRules.options.format': 'Output format: markdown, formatted, or raw',
  'commands.importRules.options.force': 'Overwrite existing files',
  'commands.importRules.options.dryRun': 'Preview changes without writing',
  'commands.importRules.options.verbose': 'Enable verbose logging',
  'commands.importAgents.description': 'Import agents from AI tool directories to .context/agents',
  'commands.importAgents.options.source': 'Source paths to scan for agents',
  'commands.importAgents.options.target': 'Target directory for imported agents',
  'commands.importAgents.options.force': 'Overwrite existing files',
  'commands.importAgents.options.dryRun': 'Preview changes without writing',
  'commands.importAgents.options.verbose': 'Enable verbose logging',
  'warnings.import.noRulesFound': 'No rules files found.',
  'warnings.import.noAgentsFound': 'No agent files found.',
  'spinner.import.detectingRules': 'Detecting rules files...',
  'spinner.import.detectingAgents': 'Detecting agent files...',
  'spinner.import.scanningPaths': 'Scanning source paths...',
  'spinner.import.importing': 'Importing to {path}...',
  'spinner.import.complete': 'Imported {count} files to {path}',
  'info.import.foundRules': 'Rules files discovered',
  'info.import.foundRulesDetail': 'Found {count} rules files to import',
  'info.import.foundAgents': 'Agent files discovered',
  'info.import.foundAgentsDetail': 'Found {count} agent files to import',
  'success.import.completed': 'Import completed successfully.',
  'errors.import.failed': 'Failed to import files',
  // PREVC Workflow translations
  // Start command translations
  'commands.previewSplash.description': 'Render the interactive splash screen preview',
  'commands.previewSplash.options.title': 'Override the splash title',
  'commands.previewSplash.options.directory': 'Directory to display in the splash',
  // MCP Install command translations
  'commands.mcpInstall.description': 'Install MCP server configuration for AI tools (Claude Code, Cursor, etc.)',
  'commands.mcpInstall.options.global': 'Install globally in home directory (default)',
  'commands.mcpInstall.options.local': 'Install locally in project directory',
  'commands.mcpInstall.options.dryRun': 'Preview changes without writing',
  'commands.mcpInstall.options.withHooks': 'Also install recommended lifecycle hooks for eligible tools',
  'commands.mcpInstall.options.noHooks': 'Do not prompt for or suggest lifecycle hooks',
  'commands.mcpInstall.options.hookFormat': 'Codex hooks format for --with-hooks: json or toml',
  'commands.mcpInstall.options.verbose': 'Enable verbose output',
  'commands.mcpInstall.selectTool': 'Select the tool to configure MCP for:',
  'commands.mcpInstall.allDetected': 'All detected tools',
  'commands.mcpUninstall.description': 'Remove dotcontext MCP server configuration from AI tools',
  'commands.mcpUninstall.options.global': 'Remove from global home-directory config (default)',
  'commands.mcpUninstall.options.local': 'Remove from local project config',
  'commands.mcpUninstall.options.dryRun': 'Preview removals without writing',
  'commands.mcpUninstall.options.verbose': 'Enable verbose output',
  'commands.mcpUninstall.selectTool': 'Select the tool to remove MCP from:',
  'commands.mcpUninstall.allDetected': 'All detected tools',
  'labels.detected': 'detected',
  'info.mcp.wouldInstall': 'Would install MCP for {tool} at {path}',
  'info.mcp.installed': 'MCP configured for {tool} at {path}',
  'info.mcp.alreadyConfigured': '{tool} already has MCP configured',
  'info.mcp.notConfigured': 'No dotcontext MCP configuration found for {tool} at {path}',
  'info.mcp.wouldUninstall': 'Would remove MCP for {tool} at {path}',
  'info.mcp.uninstalled': 'Removed MCP for {tool} at {path}',
  'info.mcp.restartTools': 'Restart your AI tools to apply the MCP configuration.',
  'info.mcp.installWithHooksIntro': 'MCP gives agents the full dotcontext tool surface. Hooks are the recommended companion for deterministic session behavior.',
  'info.mcp.hooksRecommendation': 'Recommended: install dotcontext lifecycle hooks. Hooks are optional, but they make dotcontext more deterministic by bootstrapping context, recording edit/bash traces, and surfacing PREVC workflow guidance.',
  'info.mcp.hooksProjectScope': 'Hooks will be installed in this project. Use `dotcontext hook install <host> --global` for home-directory hooks.',
  'info.mcp.hooksRecommendedNextStep': 'Recommended next step:\n{commands}',
  'info.mcp.hooksSkipped': 'Skipped hooks. You can install them later with:\n{commands}',
  'info.mcp.hooksAvailable': 'Hooks are available for Claude Code, Codex CLI, and Pi. Install them later with:\n{commands}',
  'success.mcp.installed': 'MCP installed for {count} tool(s)',
  'success.mcp.uninstalled': 'MCP removed for {count} tool(s)',
  'warnings.mcp.noToolsDetected': 'No supported AI tools detected. Specify a tool manually.',
  'warnings.mcp.noEligibleHooks': 'No eligible hook host exists for the selected MCP tool(s). Hooks are currently supported for Claude Code, Codex CLI, and Pi.',
  'warnings.mcp.recommendedHookInstallFailed': 'Could not install recommended hooks for {host}. MCP remains configured. You can retry with: {command}',
  'errors.mcp.unsupportedTool': 'Unsupported tool: {tool}. Supported: {supported}',
  'errors.mcp.installFailed': 'Failed to install MCP for {tool}',
  'errors.mcp.uninstallFailed': 'Failed to uninstall MCP for {tool}',
  'errors.mcp.uninstallReadFailed': 'Failed to read MCP configuration for {tool}',
  'errors.mcp.hookOptionsConflict': 'Use either --with-hooks or --no-hooks, not both.',
  'errors.mcp.invalidHookFormat': 'Invalid hook format "{format}". Expected json or toml.',
  'prompts.mcpInstall.installRecommendedHooks': 'Install recommended hooks for {host} in this project now?',
  'prompts.mcpInstall.selectRecommendedHooks': 'Select recommended hooks to install in this project:',
  // Hook command translations
  'commands.hook.description': 'Install and manage dotcontext host hooks',
  'commands.hookInstall.description': 'Install dotcontext hooks for Claude Code, Codex CLI, or Pi',
  'commands.hookInstall.options.global': 'Install globally in home directory',
  'commands.hookInstall.options.local': 'Install locally in project directory (default)',
  'commands.hookInstall.options.dryRun': 'Preview changes without writing',
  'commands.hookInstall.options.verbose': 'Enable verbose output',
  'commands.hookInstall.options.format': 'Codex only: hooks.json (json) or config.toml inline (toml)',
  'commands.hookInstall.selectHost': 'Select the host to configure hooks for:',
  'commands.hookInstall.allDetected': 'All detected hosts',
  'commands.hookDispatch.description': 'Dispatch a host hook event through dotcontext harness',
  'commands.hookDispatch.options.source': 'Hook source host: claude-code or codex',
  'commands.hookDispatch.options.repoPath': 'Repository path override',
  'commands.hookUninstall.description': 'Remove dotcontext hook configuration from a host',
  'info.hook.wouldInstall': 'Would install hooks for {host} at {path}',
  'info.hook.installed': 'Hooks configured for {host} at {path}',
  'info.hook.alreadyConfigured': '{host} already has dotcontext hooks configured',
  'info.hook.piInstructions': 'Run: pi install npm:@dotcontext/pi\nThen add dotcontext MCP to .mcp.json if you want the full tool surface (see docs).',
  'info.hook.piUninstallInstructions': 'Run: pi uninstall @dotcontext/pi',
  'info.hook.piMcpSnippetDryRun': 'Would write MCP snippet to {path}',
  'info.hook.piMcpSnippetWritten': 'Wrote MCP snippet to {path}',
  'info.hook.piMcpAlreadyConfigured': '.mcp.json already includes dotcontext MCP server',
  'success.hook.installed': 'Hooks installed for {count} host(s)',
  'success.hook.uninstalled': 'Hooks removed for {count} host(s)',
  'errors.hook.unsupportedHost': 'Unsupported host: {host}. Supported: {supported}',
  'errors.hook.dispatchFailed': 'Hook dispatch failed',
  // MCP tool display names
  // Export command translations
  'commands.export.description': 'Export rules from .context to AI tool directories',
  'commands.export.options.source': 'Source directory for rules',
  'commands.export.options.targets': 'Target paths to export to',
  'commands.export.options.preset': 'Export preset: cursor, claude, github, windsurf, cline, aider, codex, or all',
  'commands.export.options.force': 'Overwrite existing files',
  'commands.export.options.dryRun': 'Preview changes without writing',
  'spinner.export.exporting': 'Exporting to {target}...',
  'spinner.export.exported': 'Exported to {target}',
  'spinner.export.skipped': 'Skipped {target} (already exists)',
  'spinner.export.failed': 'Failed to export to {target}',
  'spinner.export.dryRun': 'Would export to {target}',
  'errors.export.noTargets': 'No export targets specified. Use --preset or --targets.',
  'errors.export.noRules': 'No rules found in source directory.',
  'success.export.completed': 'Exported rules to {count} target(s)',
  // Report command translations
  'commands.report.description': 'Generate workflow progress report',
  'commands.report.options.format': 'Output format: console, markdown, or json',
  'commands.report.options.output': 'Output file path (for markdown/json)',
  'commands.report.options.includeStack': 'Include technology stack analysis',
  'errors.report.noWorkflow': 'No workflow found. Run "workflow init" first.',
  'success.report.saved': 'Report saved to {path}',
  // Visual dashboard translations
  // Auto-advance translations
  // Workflow template translations
  // Skill command translations
  'commands.skill.description': 'Manage skills (on-demand expertise for AI agents)',
  'commands.skill.list.description': 'List available skills',
  'commands.skill.export.description': 'Export skills to AI tool directories (Claude, Gemini, Codex)',
  // Synchronize my context translations
  'prompts.main.choice.quickSync': 'Synchronize my context',
  'prompts.quickSync.selectComponents': 'Select components to sync:',
  'prompts.quickSync.components.agents': 'Agents',
  'prompts.quickSync.components.skills': 'Skills',
  'prompts.quickSync.components.docs': 'Documentation',
  'prompts.quickSync.noComponentsSelected': 'No components selected',
  'prompts.quickSync.selectAgentTargets': 'Select agent sync targets:',
  'prompts.quickSync.selectSkillTargets': 'Select skill export targets:',
  'prompts.quickSync.selectDocTargets': 'Select doc export targets:',
  'prompts.quickSync.syncing.agents': 'Syncing agents...',
  'prompts.quickSync.syncing.skills': 'Exporting skills...',
  'prompts.quickSync.syncing.rules': 'Exporting rules...',
  'prompts.quickSync.syncing.docs': 'Checking docs...',
  'prompts.quickSync.docsOutdated': '{days} days old',
  'success.quickSync.complete': 'Sync complete',
  // Import my context translations
  'prompts.main.choice.reverseSync': 'Import my context',
  'prompts.reverseSync.detecting': 'Detecting AI tool configurations...',
  'prompts.reverseSync.detected': 'Detected AI Tools:',
  'prompts.reverseSync.noFilesFound': 'No AI tool configuration files found',
  'prompts.reverseSync.noComponentsSelected': 'No components selected for import',
  'prompts.reverseSync.selectComponents': 'Select components to import:',
  'prompts.reverseSync.mergeStrategy': 'How should conflicts be handled?',
  'prompts.reverseSync.strategy.skip': 'Skip existing files',
  'prompts.reverseSync.strategy.overwrite': 'Overwrite existing files',
  'prompts.reverseSync.strategy.merge': 'Merge content (append)',
  'prompts.reverseSync.strategy.rename': 'Rename new files',
  'success.reverseSync.complete': 'Imported {count} files',
  'errors.reverseSync.failed': 'Reverse sync failed',
  // Manage submenus
  'prompts.main.choice.settings': 'Settings (language)',
  'prompts.main.choice.integrations': 'Integrations',
  // Integrations submenu
  'prompts.integrations.action': 'Integrations:',
  'prompts.integrations.choice.installMcp': 'Install MCP',
  'prompts.integrations.choice.uninstallMcp': 'Uninstall MCP',
  'prompts.integrations.choice.installHooks': 'Install Hooks',
  'prompts.integrations.choice.uninstallHooks': 'Uninstall Hooks',
  'prompts.integrations.choice.installPiExtension': 'Install Pi Extension',
  'prompts.integrations.choice.uninstallPiExtension': 'Uninstall Pi Extension',
  'prompts.integrations.choice.back': 'Back',
  'prompts.integrations.codexHookFormat': 'Codex hook config format:',
  'prompts.integrations.removePiMcp': 'Remove Pi MCP config too?',
  // Agents submenu
  // Create custom agent
  // Settings submenu
  // Mode selection (interactive entry)
  // More options submenu
  // Synchronize my context mode
  'prompts.quickSync.mode': 'Sync all (agents, skills, docs) to common targets?',
  'prompts.quickSync.mode.syncAll': 'Yes, sync all',
  'prompts.quickSync.mode.customize': 'Customize targets...',
  'prompts.quickSync.mode.cancel': 'Cancel',
  // Compact status
  'status.compact': '✓ Context ready ({docs} docs, {agents} agents, {skills} skills)',
  'status.outdated': '⚠ Context outdated ({days} days) - refresh via MCP',
  'status.new': 'No context found. Use Integrations or Import my context.',
  'status.unfilled': 'Context found, {count} files still need content',
  'status.detected.project': 'Detected: {languages} project',
  // Hit Enter / Press Enter
  // Environment variable loading
  // Config summary labels
  // API key validation
  // Back/cancel options
} as const;

export type TranslationKey = keyof typeof englishMessages;

type TranslationDictionary = Record<TranslationKey, string>;

const portugueseMessages: TranslationDictionary = {
  'cli.description': 'Sincronize assets de .context, faça reverse-sync do estado das ferramentas e instale integrações MCP para o seu repositório',
  'global.options.lang': 'Idioma para a saída do CLI (en ou pt-BR)',
  'ui.projectConfiguration.title': 'Configuração do Projeto',
  'ui.projectConfiguration.repository': 'Repositório',
  'ui.projectConfiguration.output': 'Saída',
  'ui.projectConfiguration.mode': 'Modo',
  'ui.progress.starting': 'Iniciando...',
  'ui.analysis.complete.title': 'Análise Concluída',
  'ui.analysis.files': 'Arquivos',
  'ui.analysis.directories': 'Diretórios',
  'ui.analysis.totalSize': 'Tamanho total',
  'ui.fileTypeDistribution.title': 'Distribuição de Tipos',
  'ui.generationSummary.title': 'Scaffold Concluído',
  'ui.generationSummary.documentation': 'Documentação',
  'ui.generationSummary.agents': 'Agentes',
  'ui.generationSummary.skills': 'Skills',
  'ui.generationSummary.timeElapsed': 'Tempo',
  'ui.generationSummary.nextStep': 'Próximo passo: personalize os templates gerados para o seu projeto.',
  'ui.error.title': 'Erro',
  'ui.splash.directoryLabel': 'diretorio',
  'info.update.available.title': 'Atualização disponível',
  'info.update.available.detail': 'Uma nova versão {latest} está disponível (atual {current}). Atualize com {command}.',
  'commands.fill.options.verbose': 'Ativa logs detalhados',
  'errors.cli.executionFailed': 'Falha na execução do CLI',
  'prompts.main.action': 'O que você gostaria de fazer?',
  'prompts.main.choice.exit': 'Sair do modo interativo',
  'prompts.language.select': 'Escolha o idioma do CLI / Choose the CLI language',
  'prompts.language.option.en': 'Inglês / English',
  'prompts.language.option.pt-BR': 'Português (Brasil) / Portuguese (Brazil)',
  'success.interactive.goodbye': 'Até logo! Obrigado por usar o dotcontext.',
  'commands.sync.description': 'Sincronizar playbooks de agentes com diretórios de ferramentas IA (.claude, .github, etc.)',
  'commands.sync.options.source': 'Diretório de origem dos agentes',
  'commands.sync.options.target': 'Diretórios de destino para sincronizar',
  'commands.sync.options.mode': 'Tipo de referência: symlink ou markdown',
  'commands.sync.options.preset': 'Preset padrão: claude, github, cursor ou all',
  'commands.sync.options.force': 'Sobrescrever arquivos/symlinks existentes',
  'commands.sync.options.dryRun': 'Pré-visualizar mudanças sem escrever',
  'commands.sync.options.verbose': 'Ativa logs detalhados',
  'prompts.main.choice.viewPending': 'Ver arquivos pendentes',
  'prompts.main.unfilledPrompt': '{count} arquivos ainda precisam de conteudo. O que você gostaria de fazer?',
  'prompts.main.pendingFilesHeader': 'Arquivos pendentes de conteúdo:',
  'errors.sync.failed': 'Falha ao sincronizar agentes',
  'errors.sync.noTargetsSpecified': 'Nenhum destino especificado. Use --target ou --preset.',
  'errors.sync.sourceMissing': 'Diretório de origem não existe: {path}',
  'errors.sync.sourceNotDirectory': 'Caminho de origem não é um diretório: {path}',
  'warnings.sync.noAgentsFound': 'Nenhum arquivo de agente encontrado no diretório de origem.',
  'spinner.sync.processing': 'Sincronizando para {path}...',
  'spinner.sync.complete': 'Sincronizados {count} arquivos para {path}',
  'spinner.sync.failed': 'Falha ao sincronizar para {path}',
  'success.sync.completed': 'Sincronização de agentes concluída. Suas ferramentas IA estão configuradas.',
  'steps.sync.processingTarget': 'Processando destino: {path}',
  'steps.sync.summary': 'Gerando resumo da sincronização',
  'info.sync.foundAgents': 'Arquivos de agentes descobertos',
  'info.sync.foundAgentsDetail': 'Encontrados {count} playbooks de agentes para sincronizar',
  // Traduções dos comandos de importação
  'commands.importRules.description': 'Importar regras do Cursor e de assistentes IA para .context/docs',
  'commands.importRules.options.source': 'Caminhos de origem para procurar regras',
  'commands.importRules.options.target': 'Diretório de destino para regras importadas',
  'commands.importRules.options.format': 'Formato de saída: markdown, formatted ou raw',
  'commands.importRules.options.force': 'Sobrescrever arquivos existentes',
  'commands.importRules.options.dryRun': 'Pré-visualizar mudanças sem escrever',
  'commands.importRules.options.verbose': 'Ativar logs detalhados',
  'commands.importAgents.description': 'Importar agentes de diretórios de ferramentas IA para .context/agents',
  'commands.importAgents.options.source': 'Caminhos de origem para procurar agentes',
  'commands.importAgents.options.target': 'Diretório de destino para agentes importados',
  'commands.importAgents.options.force': 'Sobrescrever arquivos existentes',
  'commands.importAgents.options.dryRun': 'Pré-visualizar mudanças sem escrever',
  'commands.importAgents.options.verbose': 'Ativar logs detalhados',
  'warnings.import.noRulesFound': 'Nenhum arquivo de regras encontrado.',
  'warnings.import.noAgentsFound': 'Nenhum arquivo de agente encontrado.',
  'spinner.import.detectingRules': 'Detectando arquivos de regras...',
  'spinner.import.detectingAgents': 'Detectando arquivos de agentes...',
  'spinner.import.scanningPaths': 'Escaneando caminhos de origem...',
  'spinner.import.importing': 'Importando para {path}...',
  'spinner.import.complete': 'Importados {count} arquivos para {path}',
  'info.import.foundRules': 'Arquivos de regras descobertos',
  'info.import.foundRulesDetail': 'Encontrados {count} arquivos de regras para importar',
  'info.import.foundAgents': 'Arquivos de agentes descobertos',
  'info.import.foundAgentsDetail': 'Encontrados {count} arquivos de agentes para importar',
  'success.import.completed': 'Importação concluída com sucesso.',
  'errors.import.failed': 'Falha ao importar arquivos',
  // PREVC Workflow translations
  // Traduções do comando start
  'commands.previewSplash.description': 'Renderizar uma previa da splash screen interativa',
  'commands.previewSplash.options.title': 'Sobrescrever o titulo da splash',
  'commands.previewSplash.options.directory': 'Diretorio exibido na splash',
  // Traduções do comando mcp:install
  'commands.mcpInstall.description': 'Instalar configuração do servidor MCP para ferramentas de IA (Claude Code, Cursor, etc.)',
  'commands.mcpInstall.options.global': 'Instalar globalmente no diretório home (padrão)',
  'commands.mcpInstall.options.local': 'Instalar localmente no diretório do projeto',
  'commands.mcpInstall.options.dryRun': 'Visualizar mudanças sem escrever',
  'commands.mcpInstall.options.withHooks': 'Também instalar hooks de lifecycle recomendados para ferramentas elegíveis',
  'commands.mcpInstall.options.noHooks': 'Não perguntar nem sugerir hooks de lifecycle',
  'commands.mcpInstall.options.hookFormat': 'Formato dos hooks do Codex para --with-hooks: json ou toml',
  'commands.mcpInstall.options.verbose': 'Habilitar saída detalhada',
  'commands.mcpInstall.selectTool': 'Selecione a ferramenta para configurar o MCP:',
  'commands.mcpInstall.allDetected': 'Todas as ferramentas detectadas',
  'commands.mcpUninstall.description': 'Remover configuração do servidor MCP dotcontext de ferramentas de IA',
  'commands.mcpUninstall.options.global': 'Remover da configuração global no diretório home (padrão)',
  'commands.mcpUninstall.options.local': 'Remover da configuração local do projeto',
  'commands.mcpUninstall.options.dryRun': 'Pré-visualizar remoções sem escrever',
  'commands.mcpUninstall.options.verbose': 'Habilitar saída detalhada',
  'commands.mcpUninstall.selectTool': 'Selecione a ferramenta da qual remover o MCP:',
  'commands.mcpUninstall.allDetected': 'Todas as ferramentas detectadas',
  'labels.detected': 'detectado',
  'info.mcp.wouldInstall': 'Instalaria MCP para {tool} em {path}',
  'info.mcp.installed': 'MCP configurado para {tool} em {path}',
  'info.mcp.alreadyConfigured': '{tool} já tem MCP configurado',
  'info.mcp.notConfigured': 'Nenhuma configuração MCP dotcontext encontrada para {tool} em {path}',
  'info.mcp.wouldUninstall': 'Removeria MCP para {tool} em {path}',
  'info.mcp.uninstalled': 'MCP removido para {tool} em {path}',
  'info.mcp.restartTools': 'Reinicie suas ferramentas de IA para aplicar a configuração do MCP.',
  'info.mcp.installWithHooksIntro': 'MCP oferece aos agents a superfície completa de ferramentas do dotcontext. Hooks são o complemento recomendado para comportamento de sessão mais determinístico.',
  'info.mcp.hooksRecommendation': 'Recomendado: instalar hooks de lifecycle do dotcontext. Hooks são opcionais, mas tornam o dotcontext mais determinístico ao fazer bootstrap de contexto, registrar traces de edição/bash e mostrar orientação do workflow PREVC.',
  'info.mcp.hooksProjectScope': 'Os hooks serão instalados neste projeto. Use `dotcontext hook install <host> --global` para hooks no diretório home.',
  'info.mcp.hooksRecommendedNextStep': 'Próximo passo recomendado:\n{commands}',
  'info.mcp.hooksSkipped': 'Hooks ignorados. Você pode instalá-los depois com:\n{commands}',
  'info.mcp.hooksAvailable': 'Hooks estão disponíveis para Claude Code, Codex CLI e Pi. Instale depois com:\n{commands}',
  'success.mcp.installed': 'MCP instalado para {count} ferramenta(s)',
  'success.mcp.uninstalled': 'MCP removido para {count} ferramenta(s)',
  'warnings.mcp.noToolsDetected': 'Nenhuma ferramenta de IA suportada detectada. Especifique uma ferramenta manualmente.',
  'warnings.mcp.noEligibleHooks': 'Não há host de hooks elegível para a(s) ferramenta(s) MCP selecionada(s). Hooks são suportados hoje para Claude Code, Codex CLI e Pi.',
  'warnings.mcp.recommendedHookInstallFailed': 'Não foi possível instalar os hooks recomendados para {host}. O MCP continua configurado. Tente novamente com: {command}',
  'errors.mcp.unsupportedTool': 'Ferramenta não suportada: {tool}. Suportadas: {supported}',
  'errors.mcp.installFailed': 'Falha ao instalar MCP para {tool}',
  'errors.mcp.uninstallFailed': 'Falha ao desinstalar MCP para {tool}',
  'errors.mcp.uninstallReadFailed': 'Falha ao ler configuração MCP para {tool}',
  'errors.mcp.hookOptionsConflict': 'Use --with-hooks ou --no-hooks, não ambos.',
  'errors.mcp.invalidHookFormat': 'Formato de hook inválido "{format}". Esperado: json ou toml.',
  'prompts.mcpInstall.installRecommendedHooks': 'Instalar hooks recomendados para {host} neste projeto agora?',
  'prompts.mcpInstall.selectRecommendedHooks': 'Selecione os hooks recomendados para instalar neste projeto:',
  // Traduções dos comandos hook
  'commands.hook.description': 'Instalar e gerenciar hooks de host do dotcontext',
  'commands.hookInstall.description': 'Instalar hooks do dotcontext para Claude Code, Codex CLI ou Pi',
  'commands.hookInstall.options.global': 'Instalar globalmente no diretório home',
  'commands.hookInstall.options.local': 'Instalar localmente no diretório do projeto (padrão)',
  'commands.hookInstall.options.dryRun': 'Visualizar mudanças sem escrever',
  'commands.hookInstall.options.verbose': 'Habilitar saída detalhada',
  'commands.hookInstall.options.format': 'Somente Codex: hooks.json (json) ou config.toml inline (toml)',
  'commands.hookInstall.selectHost': 'Selecione o host para configurar hooks:',
  'commands.hookInstall.allDetected': 'Todos os hosts detectados',
  'commands.hookDispatch.description': 'Despachar um evento de hook do host pelo harness dotcontext',
  'commands.hookDispatch.options.source': 'Host de origem: claude-code ou codex',
  'commands.hookDispatch.options.repoPath': 'Substituir caminho do repositório',
  'commands.hookUninstall.description': 'Remover configuração de hooks dotcontext de um host',
  'info.hook.wouldInstall': 'Instalaria hooks para {host} em {path}',
  'info.hook.installed': 'Hooks configurados para {host} em {path}',
  'info.hook.alreadyConfigured': '{host} já possui hooks dotcontext configurados',
  'info.hook.piInstructions': 'Execute: pi install npm:@dotcontext/pi\nDepois adicione o MCP dotcontext em .mcp.json se quiser a superfície completa de ferramentas (veja a documentação).',
  'info.hook.piUninstallInstructions': 'Execute: pi uninstall @dotcontext/pi',
  'info.hook.piMcpSnippetDryRun': 'Escreveria snippet MCP em {path}',
  'info.hook.piMcpSnippetWritten': 'Snippet MCP escrito em {path}',
  'info.hook.piMcpAlreadyConfigured': '.mcp.json já inclui o servidor MCP dotcontext',
  'success.hook.installed': 'Hooks instalados para {count} host(s)',
  'success.hook.uninstalled': 'Hooks removidos para {count} host(s)',
  'errors.hook.unsupportedHost': 'Host não suportado: {host}. Suportados: {supported}',
  'errors.hook.dispatchFailed': 'Falha no dispatch de hook',
  // Nomes de exibição das ferramentas MCP
  // Traduções do comando export
  'commands.export.description': 'Exportar regras de .context para diretórios de ferramentas IA',
  'commands.export.options.source': 'Diretório fonte das regras',
  'commands.export.options.targets': 'Caminhos de destino para exportar',
  'commands.export.options.preset': 'Preset de exportação: cursor, claude, github, windsurf, cline, aider, codex ou all',
  'commands.export.options.force': 'Sobrescrever arquivos existentes',
  'commands.export.options.dryRun': 'Pré-visualizar mudanças sem escrever',
  'spinner.export.exporting': 'Exportando para {target}...',
  'spinner.export.exported': 'Exportado para {target}',
  'spinner.export.skipped': 'Pulado {target} (já existe)',
  'spinner.export.failed': 'Falha ao exportar para {target}',
  'spinner.export.dryRun': 'Exportaria para {target}',
  'errors.export.noTargets': 'Nenhum destino de exportação especificado. Use --preset ou --targets.',
  'errors.export.noRules': 'Nenhuma regra encontrada no diretório fonte.',
  'success.export.completed': 'Regras exportadas para {count} destino(s)',
  // Traduções do comando report
  'commands.report.description': 'Gerar relatório de progresso do workflow',
  'commands.report.options.format': 'Formato de saída: console, markdown ou json',
  'commands.report.options.output': 'Caminho do arquivo de saída (para markdown/json)',
  'commands.report.options.includeStack': 'Incluir análise da stack de tecnologia',
  'errors.report.noWorkflow': 'Nenhum workflow encontrado. Execute "workflow init" primeiro.',
  'success.report.saved': 'Relatório salvo em {path}',
  // Traduções do dashboard visual
  // Traduções do auto-advance
  // Traduções de templates de workflow
  // Traduções do comando skill
  'commands.skill.description': 'Gerenciar skills (expertise sob demanda para agentes IA)',
  'commands.skill.list.description': 'Listar skills disponíveis',
  'commands.skill.export.description': 'Exportar skills para diretórios de ferramentas IA (Claude, Gemini, Codex)',
  // Synchronize my context translations
  'prompts.main.choice.quickSync': 'Synchronize my context',
  'prompts.quickSync.selectComponents': 'Selecione os componentes para sincronizar:',
  'prompts.quickSync.components.agents': 'Agents',
  'prompts.quickSync.components.skills': 'Skills',
  'prompts.quickSync.components.docs': 'Documentação',
  'prompts.quickSync.noComponentsSelected': 'Nenhum componente selecionado',
  'prompts.quickSync.selectAgentTargets': 'Selecione os destinos para agents:',
  'prompts.quickSync.selectSkillTargets': 'Selecione os destinos para skills:',
  'prompts.quickSync.selectDocTargets': 'Selecione os destinos para docs:',
  'prompts.quickSync.syncing.agents': 'Sincronizando agents...',
  'prompts.quickSync.syncing.skills': 'Exportando skills...',
  'prompts.quickSync.syncing.rules': 'Exportando regras...',
  'prompts.quickSync.syncing.docs': 'Verificando docs...',
  'prompts.quickSync.docsOutdated': '{days} dias atrás',
  'success.quickSync.complete': 'Sincronização completa',
  // Import my context translations
  'prompts.main.choice.reverseSync': 'Import my context',
  'prompts.reverseSync.detecting': 'Detectando configurações de ferramentas IA...',
  'prompts.reverseSync.detected': 'Ferramentas IA Detectadas:',
  'prompts.reverseSync.noFilesFound': 'Nenhum arquivo de configuração de ferramentas IA encontrado',
  'prompts.reverseSync.noComponentsSelected': 'Nenhum componente selecionado para importação',
  'prompts.reverseSync.selectComponents': 'Selecione os componentes para importar:',
  'prompts.reverseSync.mergeStrategy': 'Como devemos lidar com conflitos?',
  'prompts.reverseSync.strategy.skip': 'Pular arquivos existentes',
  'prompts.reverseSync.strategy.overwrite': 'Sobrescrever arquivos existentes',
  'prompts.reverseSync.strategy.merge': 'Mesclar conteúdo (anexar)',
  'prompts.reverseSync.strategy.rename': 'Renomear novos arquivos',
  'success.reverseSync.complete': '{count} arquivos importados',
  'errors.reverseSync.failed': 'Reverse sync falhou',
  // Manage submenus
  'prompts.main.choice.settings': 'Configurações (idioma)',
  'prompts.main.choice.integrations': 'Integrações',
  // Submenu de integrações
  'prompts.integrations.action': 'Integrações:',
  'prompts.integrations.choice.installMcp': 'Instalar MCP',
  'prompts.integrations.choice.uninstallMcp': 'Desinstalar MCP',
  'prompts.integrations.choice.installHooks': 'Instalar Hooks',
  'prompts.integrations.choice.uninstallHooks': 'Desinstalar Hooks',
  'prompts.integrations.choice.installPiExtension': 'Instalar Extensão Pi',
  'prompts.integrations.choice.uninstallPiExtension': 'Desinstalar Extensão Pi',
  'prompts.integrations.choice.back': 'Voltar',
  'prompts.integrations.codexHookFormat': 'Formato da configuração de hooks do Codex:',
  'prompts.integrations.removePiMcp': 'Remover também a configuração MCP do Pi?',
  // Agents submenu
  // Create custom agent
  // Settings submenu
  // Mode selection (interactive entry)
  // More options submenu
  // Synchronize my context mode
  'prompts.quickSync.mode': 'Sincronizar tudo (agents, skills, docs) para destinos comuns?',
  'prompts.quickSync.mode.syncAll': 'Sim, sincronizar tudo',
  'prompts.quickSync.mode.customize': 'Personalizar destinos...',
  'prompts.quickSync.mode.cancel': 'Cancelar',
  // Compact status
  'status.compact': '✓ Contexto pronto ({docs} docs, {agents} agents, {skills} skills)',
  'status.outdated': '⚠ Contexto desatualizado ({days} dias) - atualize via MCP',
  'status.new': 'Nenhum contexto encontrado. Use Integrações ou Import my context.',
  'status.unfilled': 'Contexto encontrado, {count} arquivos ainda precisam de conteúdo',
  'status.detected.project': 'Detectado: projeto {languages}',
  // Hit Enter / Press Enter
  // Environment variable loading
  // Config summary labels
  // API key validation
  // Back/cancel options
};

const dictionaries: Record<Locale, TranslationDictionary> = {
  en: englishMessages,
  'pt-BR': portugueseMessages
};

export type TranslateParams = Record<string, string | number | undefined>;

export type TranslateFn = (key: TranslationKey, params?: TranslateParams) => string;

export function createTranslator(locale: Locale): TranslateFn {
  const normalized = normalizeLocale(locale);
  return (key: TranslationKey, params?: TranslateParams) => {
    const dictionary = dictionaries[normalized] || dictionaries[DEFAULT_LOCALE];
    const fallback = dictionaries[DEFAULT_LOCALE];
    const template = dictionary[key] ?? fallback[key];
    return fillTemplate(template, params);
  };
}

export function normalizeLocale(locale: string): Locale {
  return resolveLocaleCandidate(locale) || DEFAULT_LOCALE;
}

export function detectLocale(
  argv: string[],
  envLocale?: string | null,
  systemLocaleCandidates: Array<string | null | undefined> = []
): Locale {
  const candidates = [
    extractLocaleFromArgs(argv),
    envLocale,
    ...systemLocaleCandidates
  ];

  for (const candidate of candidates) {
    const resolved = resolveLocaleCandidate(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return DEFAULT_LOCALE;
}

function extractLocaleFromArgs(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const segment = argv[index];
    if (segment === '--lang' || segment === '--language' || segment === '-l') {
      return argv[index + 1];
    }
    if (segment.startsWith('--lang=')) {
      return segment.split('=')[1];
    }
    if (segment.startsWith('--language=')) {
      return segment.split('=')[1];
    }
  }
  return undefined;
}

function fillTemplate(template: string, params?: TranslateParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (_match, key) => {
    const value = params[key];
    return value === undefined ? '' : String(value);
  });
}

function resolveLocaleCandidate(locale?: string | null): Locale | undefined {
  if (!locale) {
    return undefined;
  }

  const trimmed = locale.trim();
  if (!trimmed) {
    return undefined;
  }

  const directMatch = SUPPORTED_LOCALES.find(candidate => candidate.toLowerCase() === trimmed.toLowerCase());
  if (directMatch) {
    return directMatch;
  }

  const normalized = trimmed.replace(/_/g, '-').split('.')[0].toLowerCase();
  if (normalized === 'c' || normalized === 'posix') {
    return undefined;
  }

  if (normalized === 'pt' || normalized.startsWith('pt-')) {
    return 'pt-BR';
  }

  if (normalized === 'en' || normalized.startsWith('en-')) {
    return 'en';
  }

  return undefined;
}
