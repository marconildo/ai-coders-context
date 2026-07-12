import { createReadStream, promises as fs } from 'fs';
import { MAX_JEST_RESULT_FILE_BYTES } from '../../../domain/execution';

export interface ProjectedJestResult {
  numPassedTests: number;
  numFailedTests: number;
  numTotalTestSuites: number;
  failures: Array<{ name: string; message: string }>;
}

export type ProjectedJestResultRead =
  | { status: 'ok'; value: ProjectedJestResult }
  | { status: 'resultFileTooLarge' }
  | { status: 'malformed' };

type PathSegment = string | number;
type JsonPath = PathSegment[];

type ObjectState = 'keyOrEnd' | 'key' | 'colon' | 'value' | 'commaOrEnd';
type ArrayState = 'valueOrEnd' | 'value' | 'commaOrEnd';
type Frame =
  | { kind: 'object'; path: JsonPath; state: ObjectState; key?: string }
  | { kind: 'array'; path: JsonPath; state: ArrayState; index: number };

const MAX_TOKEN_STRING_CHARS = 4_096;

function samePath(left: JsonPath, right: JsonPath): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function assertionPath(path: JsonPath): boolean {
  return path.length === 4 && path[0] === 'testResults' && typeof path[1] === 'number'
    && path[2] === 'assertionResults' && typeof path[3] === 'number';
}

class JestProjection {
  readonly result: ProjectedJestResult = {
    numPassedTests: 0,
    numFailedTests: 0,
    numTotalTestSuites: 0,
    failures: [],
  };

  private current?: {
    path: JsonPath;
    status?: string;
    fullName?: string;
    title?: string;
    failureMessages: string[];
  };

  startObject(path: JsonPath): void {
    if (assertionPath(path)) {
      this.current = { path, failureMessages: [] };
    }
  }

  endObject(path: JsonPath): void {
    if (!this.current || !samePath(this.current.path, path)) return;
    if (this.current.status === 'failed' && this.result.failures.length < 100) {
      this.result.failures.push({
        name: (this.current.fullName ?? this.current.title ?? 'unknown').slice(0, 2_000),
        message: this.current.failureMessages.join('\n').slice(0, 2_000),
      });
    }
    this.current = undefined;
  }

  primitive(path: JsonPath, value: string | number | boolean | null): void {
    if (path.length === 1 && typeof value === 'number') {
      if (path[0] === 'numPassedTests') this.result.numPassedTests = value;
      if (path[0] === 'numFailedTests') this.result.numFailedTests = value;
      if (path[0] === 'numTotalTestSuites') this.result.numTotalTestSuites = value;
      return;
    }
    if (!this.current || path.length < 5) return;
    const base = path.slice(0, 4);
    if (!samePath(base, this.current.path)) return;
    const field = path[4];
    if (field === 'status' && typeof value === 'string') this.current.status = value;
    if (field === 'fullName' && typeof value === 'string') this.current.fullName = value;
    if (field === 'title' && typeof value === 'string') this.current.title = value;
    if (
      field === 'failureMessages'
      && typeof path[5] === 'number'
      && typeof value === 'string'
      && this.current.failureMessages.length < 10
    ) {
      this.current.failureMessages.push(value.slice(0, 2_000));
    }
  }
}

class StreamingJsonProjector {
  private readonly frames: Frame[] = [];
  private readonly projection = new JestProjection();
  private started = false;
  private complete = false;
  private failed = false;
  private mode: 'normal' | 'string' | 'number' | 'literal' = 'normal';
  private stringValue = '';
  private escaped = false;
  private unicodeDigits = '';
  private scalarValue = '';

  write(chunk: string): void {
    for (let index = 0; index < chunk.length && !this.failed; index += 1) {
      const char = chunk[index];
      if (!this.started) {
        if (char === '{') {
          this.started = true;
          this.consumePunctuation(char);
        }
        continue;
      }

      if (this.complete) {
        if (!/\s/.test(char)) this.failed = true;
        continue;
      }

      if (this.mode === 'string') {
        this.consumeStringCharacter(char);
        continue;
      }
      if (this.mode === 'number' || this.mode === 'literal') {
        if (/\s|[\]},{:]/.test(char)) {
          this.finishScalar();
          index -= 1;
        } else {
          if (this.scalarValue.length < 128) this.scalarValue += char;
          else this.failed = true;
        }
        continue;
      }
      if (/\s/.test(char)) continue;
      if (char === '"') {
        this.mode = 'string';
        this.stringValue = '';
        this.escaped = false;
        this.unicodeDigits = '';
      } else if (/[\[\]{},:]/.test(char)) {
        this.consumePunctuation(char);
      } else if (char === '-' || /[0-9]/.test(char)) {
        this.mode = 'number';
        this.scalarValue = char;
      } else if (/[tfn]/.test(char)) {
        this.mode = 'literal';
        this.scalarValue = char;
      } else {
        this.failed = true;
      }
    }
  }

  finish(): ProjectedJestResult | null {
    if (this.mode === 'number' || this.mode === 'literal') this.finishScalar();
    if (this.mode !== 'normal' || this.failed || !this.started || !this.complete) return null;
    return this.projection.result;
  }

  private appendString(char: string): void {
    if (this.stringValue.length < MAX_TOKEN_STRING_CHARS) this.stringValue += char;
  }

  private consumeStringCharacter(char: string): void {
    if (this.unicodeDigits) {
      if (!/[0-9a-fA-F]/.test(char)) {
        this.failed = true;
        return;
      }
      this.unicodeDigits += char;
      if (this.unicodeDigits.length === 5) {
        this.appendString(String.fromCharCode(Number.parseInt(this.unicodeDigits.slice(1), 16)));
        this.unicodeDigits = '';
        this.escaped = false;
      }
      return;
    }
    if (this.escaped) {
      if (char === 'u') {
        this.unicodeDigits = 'u';
        return;
      }
      const escapes: Record<string, string> = {
        '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
      };
      if (!(char in escapes)) {
        this.failed = true;
        return;
      }
      this.appendString(escapes[char]);
      this.escaped = false;
      return;
    }
    if (char === '\\') {
      this.escaped = true;
    } else if (char === '"') {
      this.mode = 'normal';
      this.consumePrimitive(this.stringValue);
    } else if (char.charCodeAt(0) < 0x20) {
      this.failed = true;
    } else {
      this.appendString(char);
    }
  }

  private finishScalar(): void {
    const raw = this.scalarValue;
    this.scalarValue = '';
    const mode = this.mode;
    this.mode = 'normal';
    if (mode === 'literal') {
      if (raw === 'true') this.consumePrimitive(true);
      else if (raw === 'false') this.consumePrimitive(false);
      else if (raw === 'null') this.consumePrimitive(null);
      else this.failed = true;
      return;
    }
    const validNumber = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw);
    const value = Number(raw);
    if (!validNumber || !Number.isFinite(value)) this.failed = true;
    else this.consumePrimitive(value);
  }

  private valuePath(): JsonPath | null {
    if (this.frames.length === 0) return [];
    const parent = this.frames[this.frames.length - 1];
    if (parent.kind === 'object') {
      if (parent.state !== 'value' || parent.key === undefined) return null;
      const path = [...parent.path, parent.key];
      parent.key = undefined;
      parent.state = 'commaOrEnd';
      return path;
    }
    if (parent.state !== 'value' && parent.state !== 'valueOrEnd') return null;
    const path = [...parent.path, parent.index];
    parent.index += 1;
    parent.state = 'commaOrEnd';
    return path;
  }

  private consumePrimitive(value: string | number | boolean | null): void {
    const top = this.frames[this.frames.length - 1];
    if (typeof value === 'string' && top?.kind === 'object'
      && (top.state === 'keyOrEnd' || top.state === 'key')) {
      top.key = value;
      top.state = 'colon';
      return;
    }
    const path = this.valuePath();
    if (!path) this.failed = true;
    else this.projection.primitive(path, value);
  }

  private consumePunctuation(char: string): void {
    if (char === '{' || char === '[') {
      const path = this.valuePath();
      if (!path) {
        this.failed = true;
        return;
      }
      if (char === '{') {
        this.frames.push({ kind: 'object', path, state: 'keyOrEnd' });
        this.projection.startObject(path);
      } else {
        this.frames.push({ kind: 'array', path, state: 'valueOrEnd', index: 0 });
      }
      return;
    }

    const top = this.frames[this.frames.length - 1];
    if (!top) {
      this.failed = true;
      return;
    }
    if (char === ':') {
      if (top.kind !== 'object' || top.state !== 'colon') this.failed = true;
      else top.state = 'value';
      return;
    }
    if (char === ',') {
      if (top.state !== 'commaOrEnd') this.failed = true;
      else if (top.kind === 'object') top.state = 'key';
      else top.state = 'value';
      return;
    }
    if (char === '}') {
      if (top.kind !== 'object' || (top.state !== 'keyOrEnd' && top.state !== 'commaOrEnd')) {
        this.failed = true;
        return;
      }
      this.frames.pop();
      this.projection.endObject(top.path);
    } else if (char === ']') {
      if (top.kind !== 'array' || (top.state !== 'valueOrEnd' && top.state !== 'commaOrEnd')) {
        this.failed = true;
        return;
      }
      this.frames.pop();
    }
    if (this.frames.length === 0) this.complete = true;
  }
}

export async function projectJestResultFile(resultPath: string): Promise<ProjectedJestResultRead> {
  try {
    const stat = await fs.stat(resultPath);
    if (stat.size > MAX_JEST_RESULT_FILE_BYTES) return { status: 'resultFileTooLarge' };

    const parser = new StreamingJsonProjector();
    const stream = createReadStream(resultPath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
    for await (const chunk of stream) parser.write(chunk);
    const value = parser.finish();
    return value ? { status: 'ok', value } : { status: 'malformed' };
  } catch {
    return { status: 'malformed' };
  }
}
