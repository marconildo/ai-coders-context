import { HarnessActionService, RUNTIME_HISTORY_LIMITS } from '../../harness';

import type { HarnessParams } from './types';
import type { MCPToolResponse } from './response';
import { createErrorResponse, createJsonResponse } from './response';

export interface HarnessOptions {
  repoPath: string;
}

const LIST_DEFAULTS: Partial<Record<HarnessParams['action'], number>> = {
  listSessions: RUNTIME_HISTORY_LIMITS.sessions.default,
  listTraces: RUNTIME_HISTORY_LIMITS.traces.default,
  listArtifacts: RUNTIME_HISTORY_LIMITS.artifacts.default,
  listTasks: RUNTIME_HISTORY_LIMITS.tasks.default,
  listHandoffs: RUNTIME_HISTORY_LIMITS.handoffs.default,
  listReplays: RUNTIME_HISTORY_LIMITS.replays.default,
  listDatasets: RUNTIME_HISTORY_LIMITS.datasets.default,
};

export async function handleHarness(
  params: HarnessParams,
  options: HarnessOptions
): Promise<MCPToolResponse> {
  const service = new HarnessActionService({ repoPath: options.repoPath });

  try {
    return createJsonResponse(await service.execute(params), {
      requestedLimit: params.limit,
      appliedLimit: params.limit ?? LIST_DEFAULTS[params.action],
    });
  } catch (error) {
    return createErrorResponse(error);
  }
}
