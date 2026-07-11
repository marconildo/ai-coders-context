/**
 * LSP Layer - Language Server Protocol integration for semantic analysis.
 *
 * Every child process is owned by one ServerHandle. Buffers, pending requests,
 * initialization and shutdown state therefore cannot leak across servers.
 */

import { spawn, execFile, ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import * as path from 'path';
import {
  TypeInfo,
  ReferenceLocation,
  LSPServerConfig,
  SupportedLanguage,
  LANGUAGE_EXTENSIONS,
} from '../types';

interface LSPMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export type LSPServerState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface LSPLifecycleEvent {
  language: string;
  projectHash: string;
  pid?: number;
  state: LSPServerState;
  timestamp: number;
  pendingRequestCount: number;
  reason?: string;
  initializeDurationMs?: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  forcedKill?: boolean;
  retrySuppressed?: boolean;
}

interface ServerHandle {
  key: string;
  language: string;
  projectPath: string;
  process: ChildProcess;
  state: LSPServerState;
  initialization: Promise<boolean>;
  stopping?: Promise<void>;
  pendingRequests: Map<number, PendingRequest>;
  timers: Set<NodeJS.Timeout>;
  receiver: LSPFrameAccumulator;
  startedAt: number;
  terminationReason?: string;
  forcedKill: boolean;
  exited: boolean;
  closed: boolean;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
}

/**
 * Incrementally assembles one LSP frame without repeatedly copying all bytes
 * received so far. Header segments are joined once after the delimiter and
 * body bytes are copied directly into their final, bounded allocation.
 */
class LSPFrameAccumulator {
  private readonly headerSegments: Buffer[] = [];
  private headerLength = 0;
  private headerDelimiterMatch = 0;
  private body?: Buffer;
  private bodyOffset = 0;

  constructor(
    private readonly maxHeaderBytes: number,
    private readonly maxBodyBytes: number,
    private readonly maxReceiveBufferBytes: number
  ) {}

  get bufferedByteLength(): number {
    return this.headerLength + this.bodyOffset;
  }

  accept(data: Buffer, onFrame: (body: Buffer) => void): string | undefined {
    let offset = 0;

    while (offset < data.length) {
      if (this.body) {
        const copyLength = Math.min(data.length - offset, this.body.length - this.bodyOffset);
        data.copy(this.body, this.bodyOffset, offset, offset + copyLength);
        offset += copyLength;
        this.bodyOffset += copyLength;

        if (this.bodyOffset === this.body.length) {
          const completedBody = this.body;
          this.body = undefined;
          this.bodyOffset = 0;
          onFrame(completedBody);
        }
        continue;
      }

      const segmentStart = offset;
      let foundHeader = false;
      while (offset < data.length) {
        const byte = data[offset++];
        this.headerLength += 1;
        this.headerDelimiterMatch = this.nextDelimiterMatch(
          this.headerDelimiterMatch,
          byte
        );

        if (this.headerDelimiterMatch === 4) {
          this.headerSegments.push(data.subarray(segmentStart, offset));
          foundHeader = true;
          break;
        }

        // Bytes matching the start of CRLFCRLF may still be the delimiter and
        // therefore are not counted as header content until the match fails.
        if (this.headerLength - this.headerDelimiterMatch > this.maxHeaderBytes) {
          return 'incomplete header limit exceeded';
        }
        if (this.headerLength > this.maxReceiveBufferBytes) {
          return 'receive buffer limit exceeded';
        }
      }

      if (!foundHeader) {
        this.headerSegments.push(data.subarray(segmentStart, offset));
        return undefined;
      }

      const headerEnd = this.headerLength - 4;
      if (headerEnd > this.maxHeaderBytes) return 'header limit exceeded';
      const headerBuffer = Buffer.concat(this.headerSegments, this.headerLength);
      const header = headerBuffer.subarray(0, headerEnd).toString('ascii');
      const contentLengthHeaders = header
        .split('\r\n')
        .filter((line) => /^Content-Length:/i.test(line));
      if (contentLengthHeaders.length !== 1) {
        return 'expected exactly one Content-Length header';
      }
      const rawContentLength = contentLengthHeaders[0]
        .slice(contentLengthHeaders[0].indexOf(':') + 1)
        .trim();
      if (!/^[0-9]+$/.test(rawContentLength)) return 'invalid Content-Length';

      const contentLength = Number(rawContentLength);
      if (
        !Number.isSafeInteger(contentLength) ||
        contentLength <= 0 ||
        contentLength > this.maxBodyBytes
      ) {
        return 'Content-Length exceeds body limit';
      }
      if (this.headerLength + contentLength > this.maxReceiveBufferBytes) {
        return 'frame exceeds receive buffer limit';
      }

      this.headerSegments.length = 0;
      this.headerLength = 0;
      this.headerDelimiterMatch = 0;
      this.body = Buffer.allocUnsafe(contentLength);
      this.bodyOffset = 0;
    }

    return undefined;
  }

  reset(): void {
    this.headerSegments.length = 0;
    this.headerLength = 0;
    this.headerDelimiterMatch = 0;
    this.body = undefined;
    this.bodyOffset = 0;
  }

  private nextDelimiterMatch(current: number, byte: number): number {
    const delimiter = [13, 10, 13, 10];
    if (byte === delimiter[current]) return current + 1;
    return byte === delimiter[0] ? 1 : 0;
  }
}

export interface LSPLayerOptions {
  /** Primarily useful to provide explicitly installed or test language servers. */
  serverConfigs?: Record<string, LSPServerConfig>;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  terminationGraceMs?: number;
  maxHeaderBytes?: number;
  maxBodyBytes?: number;
  maxReceiveBufferBytes?: number;
  onLifecycleEvent?: (event: LSPLifecycleEvent) => void;
}

const LSP_SERVER_CONFIGS: Record<string, LSPServerConfig> = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    rootPatterns: ['tsconfig.json', 'package.json'],
  },
  javascript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    rootPatterns: ['package.json', 'jsconfig.json'],
  },
  python: {
    command: 'pylsp',
    args: [],
    rootPatterns: ['setup.py', 'pyproject.toml', 'requirements.txt', 'setup.cfg'],
  },
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
export const MAX_LSP_HEADER_BYTES = 16 * 1024;
export const MAX_LSP_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_LSP_RECEIVE_BUFFER_BYTES =
  MAX_LSP_HEADER_BYTES + 4 + MAX_LSP_BODY_BYTES;

function boundedProtocolLimit(value: number | undefined, maximum: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return maximum;
  return Math.min(value, maximum);
}

export class LSPLayer {
  private readonly handles = new Map<string, ServerHandle>();
  private readonly failedCircuits = new Set<string>();
  private readonly serverConfigs: Record<string, LSPServerConfig>;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly terminationGraceMs: number;
  private readonly maxHeaderBytes: number;
  private readonly maxBodyBytes: number;
  private readonly maxReceiveBufferBytes: number;
  private readonly onLifecycleEvent?: (event: LSPLifecycleEvent) => void;
  private messageId = 0;
  private shuttingDown?: Promise<void>;

  constructor(options: LSPLayerOptions = {}) {
    this.serverConfigs = options.serverConfigs || LSP_SERVER_CONFIGS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.maxHeaderBytes = boundedProtocolLimit(options.maxHeaderBytes, MAX_LSP_HEADER_BYTES);
    this.maxBodyBytes = boundedProtocolLimit(options.maxBodyBytes, MAX_LSP_BODY_BYTES);
    this.maxReceiveBufferBytes = boundedProtocolLimit(
      options.maxReceiveBufferBytes,
      MAX_LSP_RECEIVE_BUFFER_BYTES
    );
    this.onLifecycleEvent = options.onLifecycleEvent;
  }

  private detectLanguage(filePath: string): SupportedLanguage | null {
    const ext = path.extname(filePath);
    return LANGUAGE_EXTENSIONS[ext] || null;
  }

  private serverKey(language: string, projectPath: string): string {
    return `${language}:${path.resolve(projectPath)}`;
  }

  async ensureServer(language: string, projectPath: string): Promise<boolean> {
    const key = this.serverKey(language, projectPath);
    if (this.failedCircuits.has(key)) {
      this.emitLifecycle(language, projectPath, 'failed', 0, { retrySuppressed: true });
      return false;
    }
    if (this.shuttingDown) return false;

    const existing = this.handles.get(key);
    if (existing?.state === 'ready') return true;
    if (existing?.state === 'starting') return existing.initialization;
    if (existing) return false;

    const config = this.serverConfigs[language];
    if (!config) return false;

    const child = spawn(config.command, config.args, {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      // A dedicated POSIX process group lets the owner terminate launchers and
      // every descendant they create. Windows uses taskkill /T below.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const handle: ServerHandle = {
      key,
      language,
      projectPath: path.resolve(projectPath),
      process: child,
      state: 'starting',
      initialization: Promise.resolve(false),
      pendingRequests: new Map(),
      timers: new Set(),
      receiver: new LSPFrameAccumulator(
        this.maxHeaderBytes,
        this.maxBodyBytes,
        this.maxReceiveBufferBytes
      ),
      startedAt: Date.now(),
      forcedKill: false,
      exited: false,
      closed: false,
    };

    // Publish the owner before any asynchronous event can act on the process.
    this.handles.set(key, handle);
    this.emitHandleLifecycle(handle, 'starting');
    this.attachProcessListeners(handle);
    handle.initialization = this.initializeHandle(handle);
    return handle.initialization;
  }

  private attachProcessListeners(handle: ServerHandle): void {
    handle.process.stdout?.on('data', (data: Buffer) => this.handleServerData(handle, data));
    // Drain stderr without retaining diagnostics in memory.
    handle.process.stderr?.on('data', () => undefined);
    handle.process.stdin?.on('error', () => undefined);
    handle.process.once('error', (error) => {
      if (handle.state !== 'stopping' && handle.state !== 'stopped') {
        const reason = `process error: ${error.message}`;
        handle.terminationReason = reason;
        handle.state = 'failed';
        this.failedCircuits.add(handle.key);
        this.emitHandleLifecycle(handle, 'failed', { reason });
        this.rejectPending(handle, new Error(`LSP server ${handle.language} failed`));
        if (!handle.process.pid) this.markClosed(handle);
        void this.terminateHandle(handle, reason);
      }
    });
    handle.process.once('close', (code, signal) => {
      handle.exitCode = code;
      handle.exitSignal = signal;
      this.markClosed(handle);
      if (handle.state !== 'stopping' && handle.state !== 'stopped') {
        handle.state = 'failed';
        handle.terminationReason ||= 'process closed unexpectedly';
        this.failedCircuits.add(handle.key);
        this.emitHandleLifecycle(handle, 'failed', {
          reason: handle.terminationReason,
          exitCode: code,
          exitSignal: signal,
        });
        this.rejectPending(handle, new Error(`LSP server ${handle.language} disconnected`));
        // The direct launcher may have left descendants in its process group.
        // Termination remains authoritative even after the launcher closes.
        void this.terminateHandle(handle, handle.terminationReason);
      }
    });
    handle.process.once('exit', (code, signal) => {
      handle.exited = true;
      handle.exitCode = code;
      handle.exitSignal = signal;
    });
  }

  private markClosed(handle: ServerHandle): void {
    if (handle.closed) return;
    handle.closed = true;
  }

  private async initializeHandle(handle: ServerHandle): Promise<boolean> {
    try {
      await this.waitForSpawn(handle);
      await this.sendRequest(handle, 'initialize', {
        processId: process.pid,
        rootUri: `file://${handle.projectPath}`,
        capabilities: {
          textDocument: {
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            references: {},
            implementation: {},
          },
        },
      });

      if (handle.state !== 'starting') throw new Error('LSP server stopped during initialize');
      this.sendNotification(handle, 'initialized', {});
      handle.state = 'ready';
      this.emitHandleLifecycle(handle, 'ready', {
        initializeDurationMs: Date.now() - handle.startedAt,
      });
      return true;
    } catch (error) {
      if (handle.state === 'stopping' || handle.state === 'stopped') {
        await handle.stopping;
        return false;
      }
      this.failedCircuits.add(handle.key);
      const reason =
        error instanceof Error ? `initialize failed: ${error.message}` : 'initialize failed';
      handle.state = 'failed';
      this.emitHandleLifecycle(handle, 'failed', {
        reason,
        initializeDurationMs: Date.now() - handle.startedAt,
      });
      await this.terminateHandle(
        handle,
        reason
      );
      return false;
    }
  }

  private waitForSpawn(handle: ServerHandle): Promise<void> {
    return new Promise((resolve, reject) => {
      const onSpawn = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error('LSP server closed before spawn confirmation'));
      };
      const cleanup = (): void => {
        handle.process.off('spawn', onSpawn);
        handle.process.off('error', onError);
        handle.process.off('close', onClose);
      };
      handle.process.once('spawn', onSpawn);
      handle.process.once('error', onError);
      handle.process.once('close', onClose);
    });
  }

  private handleServerData(handle: ServerHandle, data: Buffer): void {
    if (handle.state === 'stopping' || handle.state === 'stopped') return;
    const error = handle.receiver.accept(data, (body) => {
      try {
        this.handleMessage(handle, JSON.parse(body.toString('utf8')) as LSPMessage);
      } catch {
        // Malformed server messages are ignored without affecting another handle.
      }
    });
    if (error) this.failProtocol(handle, error);
  }

  private failProtocol(handle: ServerHandle, detail: string): void {
    if (
      handle.state === 'failed' ||
      handle.state === 'stopping' ||
      handle.state === 'stopped'
    ) return;

    const reason = `protocol overflow: ${detail}`;
    handle.receiver.reset();
    handle.terminationReason = reason;
    handle.state = 'failed';
    this.failedCircuits.add(handle.key);
    this.emitHandleLifecycle(handle, 'failed', { reason });
    this.rejectPending(handle, new Error(`LSP server ${handle.language} ${reason}`));
    void this.terminateHandle(handle, reason);
  }

  private handleMessage(handle: ServerHandle, message: LSPMessage): void {
    if (message.id === undefined) return;
    const pending = handle.pendingRequests.get(message.id);
    if (!pending) return;

    handle.pendingRequests.delete(message.id);
    this.clearHandleTimeout(handle, pending.timeout);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  private sendRequest(
    handle: ServerHandle,
    method: string,
    params: unknown,
    timeoutMs = this.requestTimeoutMs
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.messageId;
      const timeout = this.setHandleTimeout(handle, () => {
        handle.pendingRequests.delete(id);
        reject(new Error(`LSP request timeout: ${method}`));
      }, timeoutMs);
      handle.pendingRequests.set(id, { resolve, reject, timeout });

      if (!this.sendMessage(handle, { jsonrpc: '2.0', id, method, params })) {
        this.clearHandleTimeout(handle, timeout);
        handle.pendingRequests.delete(id);
        reject(new Error(`LSP server ${handle.language} is not writable`));
      }
    });
  }

  private sendNotification(handle: ServerHandle, method: string, params: unknown): boolean {
    return this.sendMessage(handle, { jsonrpc: '2.0', method, params });
  }

  private sendMessage(handle: ServerHandle, message: LSPMessage): boolean {
    const stdin = handle.process.stdin;
    if (!stdin?.writable || stdin.destroyed) return false;
    const content = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
    try {
      stdin.write(header + content);
      return true;
    } catch {
      return false;
    }
  }

  private rejectPending(handle: ServerHandle, error: Error): void {
    for (const pending of handle.pendingRequests.values()) {
      this.clearHandleTimeout(handle, pending.timeout);
      pending.reject(error);
    }
    handle.pendingRequests.clear();
  }

  private async terminateHandle(
    handle: ServerHandle,
    reason: string,
    waitForNaturalExit = false
  ): Promise<void> {
    if (handle.stopping) return handle.stopping;
    if (handle.state === 'stopped' && handle.closed) return;

    handle.terminationReason = reason;
    handle.state = 'stopping';
    this.emitHandleLifecycle(handle, 'stopping', { reason });
    handle.stopping = (async () => {
      this.rejectPending(handle, new Error(`LSP server ${handle.language} terminated: ${reason}`));
      handle.process.stdin?.end();

      if (this.processTreeIsAlive(handle)) {
        const exitedNaturally =
          waitForNaturalExit &&
          (await this.waitForProcessTreeExit(handle, this.terminationGraceMs));
        if (!exitedNaturally) {
          await this.signalProcessTree(handle, 'SIGTERM');
          if (!(await this.waitForProcessTreeExit(handle, this.terminationGraceMs))) {
            handle.forcedKill = true;
            await this.signalProcessTree(handle, 'SIGKILL');
            // Some descendants inherit the server's stdio and can prevent the
            // ChildProcess `close` event. Never await it without a deadline.
            await this.waitForProcessTreeExit(handle, this.terminationGraceMs);
          }
        }
      }

      handle.state = 'stopped';
      this.emitHandleLifecycle(handle, 'stopped', {
        reason,
        exitCode: handle.exitCode,
        exitSignal: handle.exitSignal,
        forcedKill: handle.forcedKill,
      });
      this.releaseHandle(handle);
    })();
    return handle.stopping;
  }

  private async signalProcessTree(
    handle: ServerHandle,
    signal: 'SIGTERM' | 'SIGKILL'
  ): Promise<void> {
    const pid = handle.process.pid;
    if (!pid) return;

    if (process.platform === 'win32') {
      await this.taskkill(pid, signal === 'SIGKILL');
      return;
    }

    try {
      // Negative PID targets the dedicated group created with detached=true.
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }

    // Fall back to the direct child if group signalling is unavailable.
    try {
      handle.process.kill(signal);
    } catch {
      // A concurrent process exit is equivalent to successful termination.
    }
  }

  private taskkill(pid: number, force: boolean): Promise<void> {
    return new Promise((resolve) => {
      const args = ['/PID', String(pid), '/T'];
      if (force) args.push('/F');
      execFile(
        'taskkill',
        args,
        { windowsHide: true, timeout: Math.max(100, this.terminationGraceMs) },
        () => resolve()
      );
    });
  }

  private processTreeIsAlive(handle: ServerHandle): boolean {
    const pid = handle.process.pid;
    if (!pid) return false;
    if (process.platform === 'win32') return !handle.exited;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private async waitForProcessTreeExit(
    handle: ServerHandle,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.processTreeIsAlive(handle)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => {
        this.setHandleTimeout(handle, resolve, Math.min(25, remaining));
      });
    }
    return true;
  }

  private setHandleTimeout(
    handle: ServerHandle,
    callback: () => void,
    timeoutMs: number
  ): NodeJS.Timeout {
    const timeout = setTimeout(() => {
      handle.timers.delete(timeout);
      callback();
    }, timeoutMs);
    handle.timers.add(timeout);
    return timeout;
  }

  private clearHandleTimeout(handle: ServerHandle, timeout: NodeJS.Timeout): void {
    clearTimeout(timeout);
    handle.timers.delete(timeout);
  }

  private releaseHandle(handle: ServerHandle): void {
    if (this.handles.get(handle.key) === handle) this.handles.delete(handle.key);
    this.rejectPending(handle, new Error(`LSP server ${handle.language} released`));
    for (const timer of handle.timers) clearTimeout(timer);
    handle.timers.clear();
    handle.receiver.reset();
    handle.process.stdin?.removeAllListeners();
    handle.process.stdout?.removeAllListeners();
    handle.process.stderr?.removeAllListeners();
    handle.process.removeAllListeners();
  }

  private emitHandleLifecycle(
    handle: ServerHandle,
    state: LSPServerState,
    details: Partial<LSPLifecycleEvent> = {}
  ): void {
    this.emitLifecycle(
      handle.language,
      handle.projectPath,
      state,
      handle.pendingRequests.size,
      { pid: handle.process.pid, ...details }
    );
  }

  private emitLifecycle(
    language: string,
    projectPath: string,
    state: LSPServerState,
    pendingRequestCount: number,
    details: Partial<LSPLifecycleEvent> = {}
  ): void {
    if (!this.onLifecycleEvent) return;
    const event: LSPLifecycleEvent = {
      language,
      projectHash: createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 12),
      state,
      timestamp: Date.now(),
      pendingRequestCount,
      ...details,
    };
    try {
      this.onLifecycleEvent(event);
    } catch {
      // Observability must never change process ownership or fallback behavior.
    }
  }

  private async readyHandle(
    language: string,
    projectPath: string
  ): Promise<ServerHandle | undefined> {
    if (!(await this.ensureServer(language, projectPath))) return undefined;
    const handle = this.handles.get(this.serverKey(language, projectPath));
    return handle?.state === 'ready' ? handle : undefined;
  }

  async getTypeInfo(
    filePath: string,
    line: number,
    column: number,
    projectPath: string
  ): Promise<TypeInfo | null> {
    const language = this.detectLanguage(filePath);
    if (!language) return null;
    const handle = await this.readyHandle(language, projectPath);
    if (!handle) return null;

    try {
      const result = await this.sendRequest(handle, 'textDocument/hover', {
        textDocument: { uri: `file://${filePath}` },
        position: { line: line - 1, character: column },
      });
      if (result && typeof result === 'object' && 'contents' in result) {
        return this.parseHoverResult((result as { contents: unknown }).contents);
      }
    } catch {
      // Fall back to the non-LSP analysis.
    }
    return null;
  }

  async findReferences(
    filePath: string,
    line: number,
    column: number,
    projectPath: string
  ): Promise<ReferenceLocation[]> {
    const language = this.detectLanguage(filePath);
    if (!language) return [];
    const handle = await this.readyHandle(language, projectPath);
    if (!handle) return [];

    try {
      const result = await this.sendRequest(handle, 'textDocument/references', {
        textDocument: { uri: `file://${filePath}` },
        position: { line: line - 1, character: column },
        context: { includeDeclaration: true },
      });
      if (Array.isArray(result)) {
        return result.map((ref: { uri: string; range: { start: { line: number; character: number } } }) => ({
          file: ref.uri.replace('file://', ''),
          line: ref.range.start.line + 1,
          column: ref.range.start.character,
        }));
      }
    } catch {
      // Fall back to an empty result.
    }
    return [];
  }

  async getDefinition(
    filePath: string,
    line: number,
    column: number,
    projectPath: string
  ): Promise<ReferenceLocation | null> {
    const language = this.detectLanguage(filePath);
    if (!language) return null;
    const handle = await this.readyHandle(language, projectPath);
    if (!handle) return null;

    try {
      const result = await this.sendRequest(handle, 'textDocument/definition', {
        textDocument: { uri: `file://${filePath}` },
        position: { line: line - 1, character: column },
      });
      if (Array.isArray(result) && result.length > 0) {
        const def = result[0] as { uri: string; range: { start: { line: number; character: number } } };
        return {
          file: def.uri.replace('file://', ''),
          line: def.range.start.line + 1,
          column: def.range.start.character,
        };
      }
    } catch {
      // Fall back to the non-LSP analysis.
    }
    return null;
  }

  async findImplementations(
    filePath: string,
    line: number,
    column: number,
    projectPath: string
  ): Promise<ReferenceLocation[]> {
    const language = this.detectLanguage(filePath);
    if (!language) return [];
    const handle = await this.readyHandle(language, projectPath);
    if (!handle) return [];

    try {
      const result = await this.sendRequest(handle, 'textDocument/implementation', {
        textDocument: { uri: `file://${filePath}` },
        position: { line: line - 1, character: column },
      });
      if (Array.isArray(result)) {
        return result.map((impl: { uri: string; range: { start: { line: number; character: number } } }) => ({
          file: impl.uri.replace('file://', ''),
          line: impl.range.start.line + 1,
          column: impl.range.start.character,
        }));
      }
    } catch {
      // Fall back to an empty result.
    }
    return [];
  }

  private parseHoverResult(contents: unknown): TypeInfo {
    let text = '';
    if (typeof contents === 'string') text = contents;
    else if (Array.isArray(contents)) {
      text = contents
        .map((c) => (typeof c === 'string' ? c : (c as { value?: string }).value || ''))
        .join('\n');
    } else if (contents && typeof contents === 'object') {
      text = (contents as { value?: string }).value || '';
    }

    const codeMatch = text.match(/```\w*\n?([\s\S]*?)\n?```/);
    const typeText = codeMatch ? codeMatch[1] : text;
    return {
      name: typeText.split('\n')[0] || 'unknown',
      fullType: typeText,
      documentation: text.replace(/```[\s\S]*?```/g, '').trim() || undefined,
    };
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return this.shuttingDown;
    this.shuttingDown = (async () => {
      const handles = [...this.handles.values()];
      await Promise.all(handles.map((handle) => this.shutdownHandle(handle)));
    })();
    return this.shuttingDown;
  }

  private async shutdownHandle(handle: ServerHandle): Promise<void> {
    if (handle.stopping) return handle.stopping;
    if (handle.state === 'ready') {
      try {
        await this.sendRequest(handle, 'shutdown', null, this.shutdownTimeoutMs);
        this.sendNotification(handle, 'exit', null);
      } catch {
        // Process termination below is authoritative even if the protocol fails.
      }
    }
    await this.terminateHandle(handle, 'layer shutdown', true);
  }

  isServerAvailable(language: string): boolean {
    return [...this.handles.values()].some(
      (handle) => handle.language === language && handle.state === 'ready'
    );
  }

  getAvailableLanguages(): string[] {
    return Object.keys(this.serverConfigs);
  }
}
