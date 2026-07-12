import { createHash } from 'crypto';

export type RuntimeHistoryDirection = 'oldest' | 'newest';

/** Source-of-truth limits shared by harness callers and transport adapters. */
export const RUNTIME_HISTORY_LIMITS = {
  sessions: { default: 50, maximum: 200 },
  artifacts: { default: 50, maximum: 200 },
  traces: { default: 100, maximum: 1000 },
  tasks: { default: 100, maximum: 1000 },
  handoffs: { default: 100, maximum: 1000 },
  replays: { default: 25, maximum: 100 },
  datasets: { default: 25, maximum: 100 },
  exploreFiles: { default: 100, maximum: 1000 },
  replayEvents: { default: 100, maximum: 1000 },
} as const;

export const DEFAULT_RUNTIME_HISTORY_PAGE_BYTES = 1024 * 1024;
export const MAX_RUNTIME_HISTORY_PAGE_BYTES = 16 * 1024 * 1024;

export interface RuntimeHistoryQuery {
  limit?: number;
  cursor?: string;
  direction?: RuntimeHistoryDirection;
  maxBytes?: number;
}

export interface RuntimeHistoryPage<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
  recordsReturned: number;
  recordsScanned: number;
  scannedBytes?: number;
  returnedBytes: number;
  byteBudget: number;
  byteLimited: boolean;
  oversizedRecordsSkipped: number;
  malformedCount?: number;
  cursorVersion: 1;
  partial: boolean;
  durationMs: number;
}

export class RuntimeHistoryCursorError extends Error {
  readonly code = 'INVALID_RUNTIME_HISTORY_CURSOR';

  constructor(message: string) {
    super(message);
    this.name = 'RuntimeHistoryCursorError';
  }
}

interface CursorEnvelope<T> {
  v: 1;
  scope: string;
  binding: string;
  position: T;
}

export function queryBinding(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

export function encodeHistoryCursor<T>(scope: string, binding: string, position: T): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, binding, position } satisfies CursorEnvelope<T>))
    .toString('base64url');
}

export function decodeHistoryCursor<T>(cursor: string | undefined, scope: string, binding: string): T | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorEnvelope<T>;
    if (parsed.v !== 1 || parsed.scope !== scope || parsed.binding !== binding || parsed.position === undefined) {
      throw new Error('cursor does not match this query');
    }
    return parsed.position;
  } catch (error) {
    if (error instanceof RuntimeHistoryCursorError) throw error;
    throw new RuntimeHistoryCursorError(`Invalid or stale runtime history cursor: ${(error as Error).message}`);
  }
}

export function boundedLimit(value: number | undefined, defaultLimit: number, maximum: number, resource: string): number {
  const limit = value ?? defaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`${resource} limit must be an integer between 1 and ${maximum}`);
  }
  return limit;
}

export function boundedPageBytes(
  value: number | undefined,
  resource: string,
  defaultBytes = DEFAULT_RUNTIME_HISTORY_PAGE_BYTES,
  maximumBytes = MAX_RUNTIME_HISTORY_PAGE_BYTES
): number {
  const bytes = value ?? defaultBytes;
  if (!Number.isInteger(bytes) || bytes < 1024 || bytes > maximumBytes) {
    throw new RangeError(`${resource} maxBytes must be an integer between 1024 and ${maximumBytes}`);
  }
  return bytes;
}

export function serializedHistoryItemBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
