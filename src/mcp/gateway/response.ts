/**
 * MCP response helpers.
 *
 * JSON responses are compact-serialized exactly once on the successful path.
 * The small `_meta.dotcontext` envelope is derived from the original value, so
 * transports never need to parse the response body for logging.
 */

export const DEFAULT_MCP_TEXT_PAYLOAD_BYTES = 1024 * 1024;
export const ABSOLUTE_MCP_TEXT_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_MCP_AUDIT_META_BYTES = 2 * 1024;

const AUDIT_SCALAR_KEYS = [
  'success',
  'currentPhase',
  'nextPhase',
  'phase',
  'scale',
  'count',
  'total',
  'status',
] as const;

export interface DotcontextAuditMetadata {
  success: boolean;
  errorCode?: string;
  summary?: Record<string, string | number | boolean | null>;
  itemCount?: number;
  partial?: boolean;
  responseBytes: number;
  serializationMs: number;
  requestedLimit?: number;
  appliedLimit?: number;
  pageTooLarge?: boolean;
}

export interface MCPToolResponse {
  [x: string]: unknown;
  content: Array<{
    type: 'text';
    text: string;
    annotations?: {
      audience?: ('user' | 'assistant')[];
      priority?: number;
    };
  }>;
  isError?: boolean;
  _meta?: {
    dotcontext: DotcontextAuditMetadata;
  };
}

export interface JsonResponseOptions {
  payloadBudgetBytes?: number;
  requestedLimit?: number;
  appliedLimit?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedPayloadBudget(requested?: number): number {
  const configured = requested ?? Number(process.env.DOTCONTEXT_MCP_PAYLOAD_BYTES);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MCP_TEXT_PAYLOAD_BYTES;
  }
  return Math.min(Math.floor(configured), ABSOLUTE_MCP_TEXT_PAYLOAD_BYTES);
}

function findItemCount(record: Record<string, unknown> | undefined): number | undefined {
  if (!record) return undefined;
  const page = asRecord(record.page);
  if (typeof page?.recordsReturned === 'number') return page.recordsReturned;
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

function artifactReference(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const artifact = asRecord(record?.artifact);
  if (!artifact || typeof artifact.id !== 'string') return undefined;
  return {
    id: artifact.id,
    ...(typeof artifact.name === 'string' ? { name: artifact.name } : {}),
    ...(typeof artifact.kind === 'string' ? { kind: artifact.kind } : {}),
    ...(typeof artifact.path === 'string' ? { path: artifact.path } : {}),
  };
}

function buildAuditMetadata(
  value: unknown,
  responseBytes: number,
  serializationMs: number,
  options: JsonResponseOptions = {},
  forceError = false
): DotcontextAuditMetadata {
  const record = asRecord(value);
  const page = asRecord(record?.page);
  const summary: Record<string, string | number | boolean | null> = {};
  for (const key of AUDIT_SCALAR_KEYS) {
    const scalar = record?.[key];
    if (scalar === null || typeof scalar === 'boolean' || typeof scalar === 'number') {
      summary[key] = scalar;
    } else if (
      typeof scalar === 'string'
      && scalar.length <= 64
      && ['currentPhase', 'nextPhase', 'phase', 'scale', 'status'].includes(key)
    ) {
      summary[key] = scalar;
    }
  }

  const errorCode = typeof record?.errorCode === 'string' && record.errorCode.length <= 80
    ? record.errorCode
    : undefined;
  const requestedLimit = options.requestedLimit;
  const appliedLimit = options.appliedLimit
    ?? (typeof page?.recordsReturned === 'number' ? page.recordsReturned : undefined);
  const meta: DotcontextAuditMetadata = {
    success: forceError ? false : typeof record?.success === 'boolean' ? record.success : true,
    ...(errorCode ? { errorCode } : {}),
    ...(Object.keys(summary).length > 0 ? { summary } : {}),
    ...(findItemCount(record) !== undefined ? { itemCount: findItemCount(record) } : {}),
    ...(typeof page?.partial === 'boolean'
      ? { partial: page.partial }
      : typeof record?.partial === 'boolean' ? { partial: record.partial } : {}),
    responseBytes,
    serializationMs,
    ...(requestedLimit !== undefined ? { requestedLimit } : {}),
    ...(appliedLimit !== undefined ? { appliedLimit } : {}),
    ...(record?.pageTooLarge === true ? { pageTooLarge: true } : {}),
  };

  // This is a programming invariant, not a fallback that silently truncates
  // metadata. Keep additions to this object scalar and content-free.
  if (Buffer.byteLength(JSON.stringify(meta), 'utf8') >= MAX_MCP_AUDIT_META_BYTES) {
    throw new Error('dotcontext MCP audit metadata exceeded 2 KiB');
  }
  return meta;
}

function jsonEnvelope(
  value: unknown,
  options: JsonResponseOptions = {},
  forceError = false
): MCPToolResponse {
  const started = performance.now();
  const text = JSON.stringify(value);
  const serializationMs = Math.max(0, performance.now() - started);
  const responseBytes = Buffer.byteLength(text, 'utf8');
  const budgetBytes = boundedPayloadBudget(options.payloadBudgetBytes);

  if (!forceError && responseBytes > budgetBytes) {
    const reference = artifactReference(asRecord(value));
    if (reference) {
      return jsonEnvelope({
        success: true,
        exported: true,
        artifact: reference,
        originalResponseBytes: responseBytes,
        budgetBytes,
      }, {
        ...options,
        payloadBudgetBytes: ABSOLUTE_MCP_TEXT_PAYLOAD_BYTES,
      });
    }
    const itemCount = findItemCount(asRecord(value));
    const currentLimit = options.appliedLimit ?? itemCount;
    const suggestedLimit = currentLimit && currentLimit > 1
      ? Math.max(1, Math.floor(currentLimit * budgetBytes / responseBytes * 0.8))
      : 1;
    const tooLarge = {
      success: false,
      errorCode: 'MCP_PAGE_TOO_LARGE',
      error: 'The MCP response exceeds the configured payload budget. Request a smaller page.',
      pageTooLarge: true,
      responseBytes,
      budgetBytes,
      suggestedLimit,
    };
    return jsonEnvelope(tooLarge, {
      ...options,
      payloadBudgetBytes: ABSOLUTE_MCP_TEXT_PAYLOAD_BYTES,
      appliedLimit: currentLimit,
    }, true);
  }

  return {
    content: [{ type: 'text', text }],
    ...(forceError ? { isError: true } : {}),
    _meta: {
      dotcontext: buildAuditMetadata(value, responseBytes, serializationMs, options, forceError),
    },
  };
}

/** Creates a successful compact JSON response. */
export function createJsonResponse(data: unknown, options: JsonResponseOptions = {}): MCPToolResponse {
  return jsonEnvelope(data, options);
}

/** Creates a typed error response while preserving the existing text content contract. */
export function createErrorResponse(error: unknown): MCPToolResponse {
  const code = asRecord(error)?.code;
  return jsonEnvelope({
    success: false,
    ...(typeof code === 'string' ? { errorCode: code } : {}),
    error: error instanceof Error ? error.message : String(error),
  }, {}, true);
}

/** Creates a bounded plain text response. */
export function createTextResponse(text: string): MCPToolResponse {
  const responseBytes = Buffer.byteLength(text, 'utf8');
  const budgetBytes = boundedPayloadBudget();
  if (responseBytes > budgetBytes) {
    return jsonEnvelope({
      success: false,
      errorCode: 'MCP_PAYLOAD_TOO_LARGE',
      error: 'The MCP text response exceeds the configured payload budget.',
      pageTooLarge: true,
      responseBytes,
      budgetBytes,
    }, {}, true);
  }
  return {
    content: [{ type: 'text', text }],
    _meta: {
      dotcontext: {
        success: true,
        responseBytes,
        serializationMs: 0,
      },
    },
  };
}

/**
 * Creates a scaffold response that includes the enhancement prompt.
 * This ensures AI agents always receive instructions to enhance generated scaffolding.
 */
export function createScaffoldResponse(
  data: Record<string, unknown>,
  options: {
    filesGenerated?: number;
    pendingFiles?: string[];
    repoPath?: string;
    enhancementPrompt?: string;
    nextSteps?: string[];
  } = {}
): MCPToolResponse {
  const { filesGenerated = 0, pendingFiles = [], repoPath, enhancementPrompt: customPrompt, nextSteps: customNextSteps } = options;
  const hasFilesToEnhance = filesGenerated > 0 || pendingFiles.length > 0;
  const hasCustomPrompt = customPrompt || customNextSteps;
  const enhancedData = {
    ...data,
    ...(hasFilesToEnhance || hasCustomPrompt) && {
      _actionRequired: true,
      _status: hasCustomPrompt && !hasFilesToEnhance ? 'ready' : 'incomplete',
      _warning: hasCustomPrompt && !hasFilesToEnhance ? 'ACTION SUGGESTED' : 'SCAFFOLDING REQUIRES ENHANCEMENT',
      enhancementPrompt: customPrompt || buildEnhancementPrompt(pendingFiles, repoPath),
      nextSteps: customNextSteps || [
        'Call context({ action: "listToFill" }) to get files needing content',
        'For each file, call context({ action: "fillSingle", filePath: "..." })',
        'Generate content based on the semantic context returned',
        'Write enhanced content using the Write tool',
      ],
      ...(pendingFiles.length > 0 && {
        pendingEnhancement: pendingFiles,
        pendingCount: pendingFiles.length,
      }),
    },
  };
  return createJsonResponse(enhancedData);
}

function buildEnhancementPrompt(pendingFiles: string[], repoPath?: string): string {
  const filesList = pendingFiles.slice(0, 5).map((f, i) => `${i + 1}. ${f}`).join('\n');
  const moreFiles = pendingFiles.length > 5 ? `\n... and ${pendingFiles.length - 5} more files` : '';
  return `IMPORTANT ENHANCEMENT REQUIRED

Scaffolding has been created but files need codebase-specific content.

Files to enhance:
${filesList}${moreFiles}

REQUIRED WORKFLOW:
1. Call context({ action: "fillSingle", filePath: "<file>" }) for each file
2. Use the returned semantic context to generate rich content
3. Write the enhanced content to the file

${repoPath ? `Repository: ${repoPath}` : ''}

DO NOT report completion until ALL files have been enhanced.`;
}
