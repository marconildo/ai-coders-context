import { promises as fs } from 'fs';

import { resolveMcpPayloadBudget } from '../gateway/response';

export interface MCPResourceResponse {
  [key: string]: unknown;
  contents: Array<{
    uri: string;
    mimeType: string;
    text: string;
  }>;
}

export interface MCPResourceBudgetOptions {
  payloadBudgetBytes?: number;
}

function resourceTooLarge(
  uri: string,
  resourceBytes: number,
  budgetBytes: number
): MCPResourceResponse {
  return {
    contents: [{
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({
        success: false,
        errorCode: 'MCP_RESOURCE_TOO_LARGE',
        error: 'The MCP resource exceeds the configured payload budget.',
        resourceBytes,
        budgetBytes,
      }),
    }],
  };
}

export function createBoundedResourceText(
  uri: string,
  mimeType: string,
  text: string,
  options: MCPResourceBudgetOptions = {}
): MCPResourceResponse {
  const budgetBytes = resolveMcpPayloadBudget(options.payloadBudgetBytes);
  const responseBytes = Buffer.byteLength(text, 'utf8');
  if (responseBytes > budgetBytes) {
    return resourceTooLarge(uri, responseBytes, budgetBytes);
  }
  return { contents: [{ uri, mimeType, text }] };
}

export function createBoundedResourceJson(
  uri: string,
  value: unknown,
  options: MCPResourceBudgetOptions = {}
): MCPResourceResponse {
  return createBoundedResourceText(
    uri,
    'application/json',
    JSON.stringify(value),
    options
  );
}

/** Read at most budget + 1 bytes so a growing file cannot bypass the stat check. */
export async function readBoundedFileResource(
  uri: string,
  filePath: string,
  mimeType = 'text/plain',
  options: MCPResourceBudgetOptions = {}
): Promise<MCPResourceResponse> {
  const budgetBytes = resolveMcpPayloadBudget(options.payloadBudgetBytes);
  const stat = await fs.stat(filePath);
  if (stat.size > budgetBytes) {
    return resourceTooLarge(uri, stat.size, budgetBytes);
  }

  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(budgetBytes + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytes,
        buffer.length - totalBytes,
        totalBytes
      );
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
    }
    if (totalBytes > budgetBytes) {
      return resourceTooLarge(uri, Math.max(stat.size, totalBytes), budgetBytes);
    }
    return createBoundedResourceText(
      uri,
      mimeType,
      buffer.subarray(0, totalBytes).toString('utf8'),
      { payloadBudgetBytes: budgetBytes }
    );
  } finally {
    await handle.close();
  }
}
