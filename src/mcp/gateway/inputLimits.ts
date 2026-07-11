export const MCP_INPUT_LIMITS = {
  scalarString: 64 * 1024,
  contentString: 1024 * 1024,
  nestedObjectBytes: 512 * 1024,
  totalBytes: 4 * 1024 * 1024,
  depth: 12,
  arrayItems: 1000,
  patternLength: 2048,
  cursorLength: 4096,
  listDefault: 100,
  listMaximum: 1000,
  maxEventsDefault: 100,
  maxEventsMaximum: 1000,
} as const;

export class MCPInputLimitError extends Error {
  readonly code = 'MCP_INPUT_LIMIT_EXCEEDED';

  constructor(message: string) {
    super(message);
    this.name = 'MCPInputLimitError';
  }
}

const NESTED_OBJECT_KEYS = new Set(['content', 'data', 'output', 'details', 'metadata', 'policy', 'options']);
const PATTERN_KEYS = new Set(['pattern', 'pathPattern', 'fileGlob']);

function serializedBytes(value: unknown, path: string): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw new MCPInputLimitError(`${path} must be JSON serializable`);
  }
}

function inspect(value: unknown, path: string, key: string | undefined, depth: number): void {
  if (depth > MCP_INPUT_LIMITS.depth) {
    throw new MCPInputLimitError(`${path} exceeds maximum depth ${MCP_INPUT_LIMITS.depth}`);
  }
  if (typeof value === 'string') {
    const maximum = key === 'content'
      ? MCP_INPUT_LIMITS.contentString
      : PATTERN_KEYS.has(key ?? '') ? MCP_INPUT_LIMITS.patternLength : MCP_INPUT_LIMITS.scalarString;
    if (Buffer.byteLength(value, 'utf8') > maximum) {
      throw new MCPInputLimitError(`${path} exceeds ${maximum} UTF-8 bytes`);
    }
    return;
  }
  if (typeof value === 'number' && ['limit', 'maxResults', 'maxEvents'].includes(key ?? '')) {
    if (!Number.isInteger(value) || value < 1 || value > MCP_INPUT_LIMITS.listMaximum) {
      throw new MCPInputLimitError(`${path} must be an integer between 1 and ${MCP_INPUT_LIMITS.listMaximum}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MCP_INPUT_LIMITS.arrayItems) {
      throw new MCPInputLimitError(`${path} exceeds ${MCP_INPUT_LIMITS.arrayItems} items`);
    }
    value.forEach((entry, index) => inspect(entry, `${path}[${index}]`, undefined, depth + 1));
    return;
  }
  if (value !== null && typeof value === 'object') {
    if (key && NESTED_OBJECT_KEYS.has(key)) {
      const bytes = serializedBytes(value, path);
      if (bytes > MCP_INPUT_LIMITS.nestedObjectBytes) {
        throw new MCPInputLimitError(`${path} exceeds ${MCP_INPUT_LIMITS.nestedObjectBytes} serialized bytes`);
      }
    }
    for (const [childKey, child] of Object.entries(value)) {
      inspect(child, `${path}.${childKey}`, childKey, depth + 1);
    }
  }
}

/** Validate protocol-wide bounds that cannot be expressed reliably with Zod shapes. */
export function validateMcpInput(value: unknown): void {
  const totalBytes = serializedBytes(value, 'input');
  if (totalBytes > MCP_INPUT_LIMITS.totalBytes) {
    throw new MCPInputLimitError(`input exceeds ${MCP_INPUT_LIMITS.totalBytes} serialized bytes`);
  }
  inspect(value, 'input', undefined, 0);
}
