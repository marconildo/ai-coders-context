/**
 * Memory-safe byte tail used by subprocess capture paths.
 *
 * The collector owns one fixed-size ring buffer. Its memory usage therefore
 * depends only on `tailBytes`, not on how much data the child writes.
 */

export const DEFAULT_SUBPROCESS_TAIL_BYTES = 8 * 1024;
/**
 * Absolute per-stream capture ceiling. Diagnostic callers may request a
 * smaller tail, but increasing it would make user-controlled configuration a
 * memory-allocation primitive.
 */
export const MAX_SUBPROCESS_TAIL_BYTES = DEFAULT_SUBPROCESS_TAIL_BYTES;
export const DEFAULT_SUBPROCESS_SOFT_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_SUBPROCESS_HARD_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_SAFE_SUBPROCESS_HARD_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_JEST_RESULT_FILE_BYTES = 32 * 1024 * 1024;

export interface SubprocessOutputLimitsInput {
  tailBytes?: number;
  hardCombinedOutputBytes?: number;
  /** Only trusted application code may opt into a ceiling above 64 MiB. */
  unsafeAllowAboveMaximum?: boolean;
}

export interface SubprocessOutputLimits {
  tailBytes: number;
  hardCombinedOutputBytes: number;
}

function positiveInteger(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

export function resolveSubprocessOutputLimits(
  input: SubprocessOutputLimitsInput = {}
): SubprocessOutputLimits {
  const tailBytes = Math.min(
    positiveInteger(input.tailBytes, DEFAULT_SUBPROCESS_TAIL_BYTES, 0),
    MAX_SUBPROCESS_TAIL_BYTES
  );
  const requestedHardLimit = positiveInteger(
    input.hardCombinedOutputBytes,
    DEFAULT_SUBPROCESS_HARD_OUTPUT_BYTES,
    1
  );
  const hardCombinedOutputBytes = input.unsafeAllowAboveMaximum
    ? requestedHardLimit
    : Math.min(requestedHardLimit, MAX_SAFE_SUBPROCESS_HARD_OUTPUT_BYTES);

  return { tailBytes, hardCombinedOutputBytes };
}

export interface BoundedByteCollectorSnapshot {
  tail: Buffer;
  totalBytes: number;
  retainedBytes: number;
  droppedBytes: number;
  truncated: boolean;
}

export class BoundedByteCollector {
  readonly tailBytes: number;
  private readonly buffer: Buffer;
  private retainedLength = 0;
  private writeOffset = 0;
  private observedBytes = 0;

  constructor(tailBytes: number = DEFAULT_SUBPROCESS_TAIL_BYTES) {
    if (!Number.isSafeInteger(tailBytes) || tailBytes < 0) {
      throw new Error('tailBytes must be a non-negative safe integer');
    }
    // Enforce the invariant at the allocation boundary as defense in depth.
    // Callers should resolve limits first, but direct construction must never
    // turn an oversized value into a large allocation.
    this.tailBytes = Math.min(tailBytes, MAX_SUBPROCESS_TAIL_BYTES);
    this.buffer = Buffer.allocUnsafe(this.tailBytes);
  }

  append(chunk: Buffer): void {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error('BoundedByteCollector accepts Buffer chunks only');
    }

    this.observedBytes += chunk.length;
    if (this.tailBytes === 0 || chunk.length === 0) return;

    if (chunk.length >= this.tailBytes) {
      chunk.copy(this.buffer, 0, chunk.length - this.tailBytes);
      this.retainedLength = this.tailBytes;
      this.writeOffset = 0;
      return;
    }

    const beforeWrap = Math.min(chunk.length, this.tailBytes - this.writeOffset);
    chunk.copy(this.buffer, this.writeOffset, 0, beforeWrap);
    if (beforeWrap < chunk.length) {
      chunk.copy(this.buffer, 0, beforeWrap);
    }

    this.writeOffset = (this.writeOffset + chunk.length) % this.tailBytes;
    this.retainedLength = Math.min(this.tailBytes, this.retainedLength + chunk.length);
  }

  get totalBytes(): number {
    return this.observedBytes;
  }

  get retainedBytes(): number {
    return this.retainedLength;
  }

  get droppedBytes(): number {
    return this.observedBytes - this.retainedLength;
  }

  get truncated(): boolean {
    return this.droppedBytes > 0;
  }

  tail(): Buffer {
    if (this.retainedLength === 0) return Buffer.alloc(0);
    if (this.retainedLength < this.tailBytes) {
      return Buffer.from(this.buffer.subarray(0, this.retainedLength));
    }
    if (this.writeOffset === 0) return Buffer.from(this.buffer);

    const result = Buffer.allocUnsafe(this.retainedLength);
    const newerLength = this.tailBytes - this.writeOffset;
    this.buffer.copy(result, 0, this.writeOffset);
    this.buffer.copy(result, newerLength, 0, this.writeOffset);
    return result;
  }

  toString(encoding: BufferEncoding = 'utf-8'): string {
    return this.tail().toString(encoding);
  }

  snapshot(): BoundedByteCollectorSnapshot {
    return {
      tail: this.tail(),
      totalBytes: this.totalBytes,
      retainedBytes: this.retainedBytes,
      droppedBytes: this.droppedBytes,
      truncated: this.truncated,
    };
  }
}
