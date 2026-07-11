import { createHash } from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';

export const DEFAULT_HOOK_STDIN_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_HOOK_TRACE_MAX_BYTES = 16 * 1024;
export const DEFAULT_TRACE_EVENT_MAX_BYTES = 256 * 1024;
export const DEFAULT_TRACE_ROTATION_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TRACE_RETAINED_SEGMENTS = 4;
export const DEFAULT_SESSION_TRACE_MAX_BYTES = 32 * 1024 * 1024;

const GLOBAL_HOOK_STDIN_MAX_BYTES = 16 * 1024 * 1024;
const GLOBAL_HOOK_TRACE_MAX_BYTES = 64 * 1024;
const GLOBAL_TRACE_EVENT_MAX_BYTES = 1024 * 1024;
const GLOBAL_TRACE_ROTATION_MAX_BYTES = 64 * 1024 * 1024;
const GLOBAL_TRACE_RETAINED_SEGMENTS = 16;
const GLOBAL_SESSION_TRACE_MAX_BYTES = 256 * 1024 * 1024;

export interface HookTracePolicy {
  maxInputBytes: number;
  maxStringBytes: number;
  maxArrayItems: number;
  maxObjectDepth: number;
  maxSerializedTraceBytes: number;
  traceRotationBytes: number;
  retainedTraceSegments: number;
  maxSessionTraceBytes: number;
}

export interface HookTraceMetrics {
  inputBytes: number;
  persistedBytes: number;
  redactedFieldCount: number;
  truncatedFieldCount: number;
  quotaStatus: 'within_limit' | 'truncated';
}

export interface SanitizedHookTraceData extends Record<string, unknown> {
  tool_input: Record<string, unknown>;
  capture: HookTraceMetrics;
}

export const DEFAULT_HOOK_TRACE_POLICY: HookTracePolicy = {
  maxInputBytes: DEFAULT_HOOK_STDIN_MAX_BYTES,
  maxStringBytes: 512,
  maxArrayItems: 20,
  maxObjectDepth: 4,
  maxSerializedTraceBytes: DEFAULT_HOOK_TRACE_MAX_BYTES,
  traceRotationBytes: DEFAULT_TRACE_ROTATION_BYTES,
  retainedTraceSegments: DEFAULT_TRACE_RETAINED_SEGMENTS,
  maxSessionTraceBytes: DEFAULT_SESSION_TRACE_MAX_BYTES,
};

const SENSITIVE_KEY = /(?:content|old[_-]?string|new[_-]?string|patch|api[_-]?key|token|secret|password|authorization|messages|prompt)/i;
const PATH_KEYS = ['file_path', 'filePath', 'path'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback;
}

function nestedValue(config: Record<string, unknown>, section: string, key: string): unknown {
  const nested = config[section];
  return isRecord(nested) ? nested[key] : undefined;
}

function configuredValue(config: Record<string, unknown>, key: string, section: string, nestedKey: string): unknown {
  return config[key] ?? nestedValue(config, section, nestedKey);
}

export function parseHookTracePolicy(value: unknown): HookTracePolicy {
  const config = isRecord(value) ? value : {};
  return {
    maxInputBytes: finiteInteger(
      configuredValue(config, 'maxInputBytes', 'stdin', 'maxBytes'),
      DEFAULT_HOOK_TRACE_POLICY.maxInputBytes,
      1024,
      GLOBAL_HOOK_STDIN_MAX_BYTES
    ),
    maxStringBytes: finiteInteger(
      configuredValue(config, 'maxStringBytes', 'trace', 'maxStringBytes'),
      DEFAULT_HOOK_TRACE_POLICY.maxStringBytes,
      32,
      4096
    ),
    maxArrayItems: finiteInteger(
      configuredValue(config, 'maxArrayItems', 'trace', 'maxArrayItems'),
      DEFAULT_HOOK_TRACE_POLICY.maxArrayItems,
      1,
      100
    ),
    maxObjectDepth: finiteInteger(
      configuredValue(config, 'maxObjectDepth', 'trace', 'maxObjectDepth'),
      DEFAULT_HOOK_TRACE_POLICY.maxObjectDepth,
      1,
      8
    ),
    maxSerializedTraceBytes: finiteInteger(
      configuredValue(config, 'maxSerializedTraceBytes', 'trace', 'maxSerializedBytes'),
      DEFAULT_HOOK_TRACE_POLICY.maxSerializedTraceBytes,
      1024,
      GLOBAL_HOOK_TRACE_MAX_BYTES
    ),
    traceRotationBytes: finiteInteger(
      configuredValue(config, 'traceRotationBytes', 'trace', 'rotationBytes'),
      DEFAULT_HOOK_TRACE_POLICY.traceRotationBytes,
      64 * 1024,
      GLOBAL_TRACE_ROTATION_MAX_BYTES
    ),
    retainedTraceSegments: finiteInteger(
      configuredValue(config, 'retainedTraceSegments', 'trace', 'retainedSegments'),
      DEFAULT_HOOK_TRACE_POLICY.retainedTraceSegments,
      0,
      GLOBAL_TRACE_RETAINED_SEGMENTS
    ),
    maxSessionTraceBytes: finiteInteger(
      configuredValue(config, 'maxSessionTraceBytes', 'trace', 'maxSessionBytes'),
      DEFAULT_HOOK_TRACE_POLICY.maxSessionTraceBytes,
      64 * 1024,
      GLOBAL_SESSION_TRACE_MAX_BYTES
    ),
  };
}

export function loadHookTracePolicy(repoPath?: string): HookTracePolicy {
  if (!repoPath) {
    return { ...DEFAULT_HOOK_TRACE_POLICY };
  }

  try {
    const configPath = path.join(path.resolve(repoPath), '.context', 'config', 'hooks.json');
    return parseHookTracePolicy(fs.readJsonSync(configPath));
  } catch {
    return { ...DEFAULT_HOOK_TRACE_POLICY };
  }
}

export function loadGenericTraceEventMaxBytes(repoPath: string): number {
  try {
    const configPath = path.join(path.resolve(repoPath), '.context', 'config', 'runtime.json');
    const value = fs.readJsonSync(configPath) as unknown;
    const config = isRecord(value) ? value : {};
    const configured = config.maxSerializedTraceBytes ?? nestedValue(config, 'trace', 'maxSerializedBytes');
    return finiteInteger(configured, DEFAULT_TRACE_EVENT_MAX_BYTES, 1024, GLOBAL_TRACE_EVENT_MAX_BYTES);
  } catch {
    return DEFAULT_TRACE_EVENT_MAX_BYTES;
  }
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) {
    return { value, truncated: false };
  }

  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(characters.slice(0, middle).join(''), 'utf8') <= maximumBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { value: characters.slice(0, low).join(''), truncated: true };
}

function hashText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof input[key] === 'string') {
      return input[key] as string;
    }
  }
  return undefined;
}

function commandBasename(command: string): string | undefined {
  const match = command.trim().match(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*([^\s;&|]+)/);
  return match?.[1] ? path.basename(match[1]) : undefined;
}

function redactCommandSecrets(command: string): { value: string; redacted: number } {
  let redacted = 0;
  const replace = (pattern: RegExp, replacement: string): void => {
    command = command.replace(pattern, (...args: unknown[]) => {
      redacted += 1;
      const key = typeof args[1] === 'string' ? args[1] : '';
      return replacement.replace('$KEY', key);
    });
  };
  replace(/['"](authorization)\s*:\s*(?:bearer\s+)?[^'"]+['"]/gi, '$KEY=[REDACTED]');
  replace(/\b(authorization)\s*[:=]\s*(?:bearer\s+)?[^\s;&|]+/gi, '$KEY=[REDACTED]');
  replace(/--?(api[-_]?key|token|password|secret)(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi, '--$KEY=[REDACTED]');
  replace(/\b(api[-_]?key|token|password|secret)=(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi, '$KEY=[REDACTED]');
  return { value: command, redacted };
}

function countSensitiveFields(value: unknown, policy: HookTracePolicy, depth = 0): number {
  if (depth > policy.maxObjectDepth) return 0;
  if (Array.isArray(value)) {
    return value.slice(0, policy.maxArrayItems)
      .reduce((sum, item) => sum + countSensitiveFields(item, policy, depth + 1), 0);
  }
  if (!isRecord(value)) return 0;
  return Object.entries(value).slice(0, policy.maxArrayItems).reduce(
    (sum, [key, child]) => sum + (SENSITIVE_KEY.test(key) ? 1 : countSensitiveFields(child, policy, depth + 1)),
    0
  );
}

interface SanitizeState {
  redactedFieldCount: number;
  truncatedFieldCount: number;
}

interface SafeKeyName {
  key: string;
  keyBytes: number;
  redacted: boolean;
  truncated: boolean;
}

function safeKeyName(key: string, index: number, policy: HookTracePolicy): SafeKeyName {
  const keyBytes = Buffer.byteLength(key, 'utf8');
  if (SENSITIVE_KEY.test(key)) {
    return { key: `__redactedKey${index + 1}`, keyBytes, redacted: true, truncated: false };
  }
  if (keyBytes > policy.maxStringBytes) {
    return { key: `__omittedKey${index + 1}`, keyBytes, redacted: false, truncated: true };
  }
  return { key, keyBytes, redacted: false, truncated: false };
}

function uniqueSafeKey(result: Record<string, unknown>, preferred: string, index: number): string {
  if (!(preferred in result)) return preferred;
  let suffix = index + 1;
  while (`__field${suffix}` in result) suffix += 1;
  return `__field${suffix}`;
}

function summarizeKeyList(
  value: Record<string, unknown>,
  policy: HookTracePolicy,
  state: SanitizeState,
  recordMetrics = true
): Array<string | { keyOmitted: true; keyBytes: number }> {
  const keys = Object.keys(value);
  const selected = keys.slice(0, policy.maxArrayItems);
  if (selected.length < keys.length) state.truncatedFieldCount += 1;
  return selected.map((key, index) => {
    const safe = safeKeyName(key, index, policy);
    if (safe.redacted) {
      if (recordMetrics) state.redactedFieldCount += 1;
      return '[REDACTED_KEY]';
    }
    if (safe.truncated) {
      if (recordMetrics) state.truncatedFieldCount += 1;
      return { keyOmitted: true, keyBytes: safe.keyBytes };
    }
    return safe.key;
  });
}

function summarizeUnknown(
  value: unknown,
  policy: HookTracePolicy,
  state: SanitizeState,
  depth = 0
): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const result = truncateUtf8(value, policy.maxStringBytes);
    if (result.truncated) state.truncatedFieldCount += 1;
    return result.truncated ? `${result.value}…[truncated]` : result.value;
  }
  if (Array.isArray(value)) {
    const values = value.slice(0, policy.maxArrayItems);
    if (values.length < value.length) state.truncatedFieldCount += 1;
    if (depth >= policy.maxObjectDepth) {
      state.truncatedFieldCount += 1;
      return { itemCount: value.length, valuesOmitted: true };
    }
    return values.map((item) => summarizeUnknown(item, policy, state, depth + 1));
  }
  if (!isRecord(value)) {
    return typeof value;
  }
  if (depth >= policy.maxObjectDepth) {
    state.truncatedFieldCount += 1;
    return { keys: summarizeKeyList(value, policy, state), valuesOmitted: true };
  }

  const result: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, policy.maxArrayItems);
  if (entries.length < Object.keys(value).length) state.truncatedFieldCount += 1;
  for (const [index, [key, child]] of entries.entries()) {
    const safe = safeKeyName(key, index, policy);
    const outputKey = uniqueSafeKey(result, safe.key, index);
    if (safe.redacted) {
      result[outputKey] = '[REDACTED]';
      state.redactedFieldCount += 1;
    } else if (safe.truncated) {
      result[outputKey] = {
        keyOmitted: true,
        keyBytes: safe.keyBytes,
        value: summarizeUnknown(child, policy, state, depth + 1),
      };
      state.truncatedFieldCount += 1;
    } else {
      result[outputKey] = summarizeUnknown(child, policy, state, depth + 1);
    }
  }
  return result;
}

function boundedMetadataString(value: string | undefined, policy: HookTracePolicy, state: SanitizeState): string | undefined {
  if (value === undefined) return undefined;
  const bounded = truncateUtf8(value, policy.maxStringBytes);
  if (bounded.truncated) state.truncatedFieldCount += 1;
  return bounded.truncated ? `${bounded.value}…[truncated]` : bounded.value;
}

function summarizeWrite(input: Record<string, unknown>, policy: HookTracePolicy, state: SanitizeState): Record<string, unknown> {
  const content = typeof input.content === 'string' ? input.content : undefined;
  const filePath = boundedMetadataString(firstString(input, PATH_KEYS), policy, state);
  return {
    ...(filePath ? { filePath } : {}),
    ...(typeof input.byte_length === 'number' ? { declaredByteLength: input.byte_length } : {}),
    ...(content !== undefined ? {
      contentBytes: Buffer.byteLength(content, 'utf8'),
      contentHash: hashText(content),
      contentOmitted: true,
    } : {}),
  };
}

function summarizeEdit(input: Record<string, unknown>, policy: HookTracePolicy, state: SanitizeState): Record<string, unknown> {
  const oldString = firstString(input, ['old_string', 'oldString']);
  const newString = firstString(input, ['new_string', 'newString']);
  const rangeKeys = ['start_line', 'end_line', 'startLine', 'endLine', 'line', 'column'];
  const range = Object.fromEntries(rangeKeys
    .filter((key) => typeof input[key] === 'number')
    .map((key) => [key, input[key]]));
  const filePath = boundedMetadataString(firstString(input, PATH_KEYS), policy, state);
  return {
    ...(filePath ? { filePath } : {}),
    ...(oldString !== undefined ? {
      oldStringBytes: Buffer.byteLength(oldString, 'utf8'),
      oldStringHash: hashText(oldString),
      oldStringOmitted: true,
    } : {}),
    ...(newString !== undefined ? {
      newStringBytes: Buffer.byteLength(newString, 'utf8'),
      newStringHash: hashText(newString),
      newStringOmitted: true,
    } : {}),
    ...(Object.keys(range).length > 0 ? { range } : {}),
  };
}

function summarizeBash(input: Record<string, unknown>, policy: HookTracePolicy, state: SanitizeState): Record<string, unknown> {
  const command = typeof input.command === 'string' ? input.command : undefined;
  if (!command) return {};
  const redactedCommand = redactCommandSecrets(command);
  state.redactedFieldCount += redactedCommand.redacted;
  const preview = truncateUtf8(redactedCommand.value, policy.maxStringBytes);
  if (preview.truncated) state.truncatedFieldCount += 1;
  const basename = boundedMetadataString(commandBasename(command), policy, state);
  return {
    ...(basename ? { commandBasename: basename } : {}),
    commandBytes: Buffer.byteLength(command, 'utf8'),
    commandPreview: preview.truncated ? `${preview.value}…[truncated]` : preview.value,
  };
}

export function sanitizeHookTraceData(
  toolName: string | undefined,
  toolInput: unknown,
  policy: HookTracePolicy = DEFAULT_HOOK_TRACE_POLICY,
  additionalData: Record<string, string | number | boolean> = {}
): SanitizedHookTraceData {
  const state: SanitizeState = { redactedFieldCount: 0, truncatedFieldCount: 0 };
  const normalizedTool = toolName?.trim().toLowerCase();
  const input = isRecord(toolInput) ? toolInput : {};
  let summary: Record<string, unknown>;
  if (normalizedTool === 'write') {
    state.redactedFieldCount = countSensitiveFields(input, policy);
    summary = summarizeWrite(input, policy, state);
  } else if (normalizedTool === 'edit') {
    state.redactedFieldCount = countSensitiveFields(input, policy);
    summary = summarizeEdit(input, policy, state);
  } else if (normalizedTool === 'bash') {
    state.redactedFieldCount = countSensitiveFields(input, policy);
    summary = summarizeBash(input, policy, state);
  } else {
    summary = summarizeUnknown(input, policy, state) as Record<string, unknown>;
  }

  const result: SanitizedHookTraceData = {
    ...additionalData,
    tool_input: summary,
    capture: {
      inputBytes: byteLength(toolInput),
      persistedBytes: 0,
      redactedFieldCount: state.redactedFieldCount,
      truncatedFieldCount: state.truncatedFieldCount,
      quotaStatus: 'within_limit',
    },
  };
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const persistedBytes = byteLength(result);
    if (result.capture.persistedBytes === persistedBytes) break;
    result.capture.persistedBytes = persistedBytes;
  }

  if (byteLength(result) > policy.maxSerializedTraceBytes) {
    result.tool_input = {
      keys: summarizeKeyList(input, policy, state, false),
      valuesOmitted: true,
    };
    result.capture.redactedFieldCount = state.redactedFieldCount;
    result.capture.truncatedFieldCount = state.truncatedFieldCount + 1;
    result.capture.quotaStatus = 'truncated';
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const persistedBytes = byteLength(result);
      if (result.capture.persistedBytes === persistedBytes) break;
      result.capture.persistedBytes = persistedBytes;
    }
  }

  if (byteLength(result) > policy.maxSerializedTraceBytes) {
    result.tool_input = {
      valuesOmitted: true,
      inputKeyCount: Object.keys(input).length,
      quota: 'max_serialized_hook_trace_bytes',
    };
    result.capture.truncatedFieldCount += 1;
    result.capture.quotaStatus = 'truncated';
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const persistedBytes = byteLength(result);
      if (result.capture.persistedBytes === persistedBytes) break;
      result.capture.persistedBytes = persistedBytes;
    }
  }

  return result;
}

export function boundGenericTraceRecord<T extends { message: string; event?: string; data?: Record<string, unknown> }>(
  trace: T,
  maximumBytes: number
): T {
  if (byteLength(trace) <= maximumBytes) {
    return trace;
  }

  const originalBytes = byteLength(trace);
  const boundedMessage = truncateUtf8(trace.message, 512);
  const bounded = {
    ...trace,
    ...(typeof trace.event === 'string' ? { event: truncateUtf8(trace.event, 256).value } : {}),
    message: boundedMessage.truncated ? `${boundedMessage.value}…[truncated]` : boundedMessage.value,
    data: {
      traceDataOmitted: true,
      originalSerializedBytes: originalBytes,
      quota: 'max_serialized_trace_bytes',
    },
  };
  return bounded as T;
}
