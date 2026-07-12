import { spawn, type ChildProcess } from 'child_process';

export const PROCESS_TREE_TERMINATION_GRACE_MS = 200;
export const PROCESS_TREE_TERMINATION_SETTLE_MS = 50;

export interface ProcessTreeTerminationOptions {
  graceMs?: number;
  settleMs?: number;
}

/**
 * Spawn children in their own process group on POSIX so timeouts and output
 * ceilings can terminate descendants which inherited the child's stdio.
 */
export function subprocessSpawnOptions(): { detached: boolean } {
  return { detached: process.platform !== 'win32' };
}

function signalPosixTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already be gone or the platform may not support
      // negative pids. Fall through to the direct-child fallback.
    }
  }
  try { child.kill(signal); } catch { /* already exited */ }
}

function forceWindowsTree(child: ChildProcess, settleMs: number): Promise<void> {
  if (!child.pid || child.pid <= 0) {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      finish();
    }, Math.max(settleMs, 250));
    killer.once('error', () => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      finish();
    });
    killer.once('close', finish);
  });
}

/**
 * Terminate a child and every descendant with bounded escalation.
 *
 * POSIX children must be spawned with `subprocessSpawnOptions()` so the
 * negative-pid signals target only their process group. Windows uses taskkill
 * with `/T` because Node does not expose Job Objects through child_process.
 */
export async function terminateProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminationOptions = {}
): Promise<void> {
  const graceMs = Math.max(0, options.graceMs ?? PROCESS_TREE_TERMINATION_GRACE_MS);
  const settleMs = Math.max(0, options.settleMs ?? PROCESS_TREE_TERMINATION_SETTLE_MS);

  if (process.platform === 'win32') {
    await forceWindowsTree(child, settleMs);
    return;
  }

  signalPosixTree(child, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  // Escalate even if the direct child has exited: an ignoring descendant can
  // still own the process group and inherited pipes.
  signalPosixTree(child, 'SIGKILL');
  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
}
