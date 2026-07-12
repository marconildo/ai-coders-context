import {
  MAX_MCP_AUDIT_META_BYTES,
  createErrorResponse,
  createJsonResponse,
} from '../response';

describe('bounded MCP responses', () => {
  it('compact-serializes the caller result exactly once on the normal path', () => {
    const payload = { success: true, sessions: [{ id: 'one' }], page: { partial: false, recordsReturned: 1 } };
    const stringify = jest.spyOn(JSON, 'stringify');

    const response = createJsonResponse(payload);

    expect(stringify.mock.calls.filter(([value]) => value === payload)).toHaveLength(1);
    expect(response.content[0].text).toBe(JSON.stringify(payload));
    stringify.mockRestore();
  });

  it('keeps audit metadata below 2 KiB and excludes caller content', () => {
    const secret = 'caller-secret-body';
    const response = createJsonResponse({
      success: true,
      content: secret,
      message: secret,
      sessions: [{ content: secret }],
      page: { partial: true, recordsReturned: 1 },
    });
    const serializedMeta = JSON.stringify(response._meta);

    expect(Buffer.byteLength(serializedMeta, 'utf8')).toBeLessThan(MAX_MCP_AUDIT_META_BYTES);
    expect(serializedMeta).not.toContain(secret);
    expect(response._meta?.dotcontext).toMatchObject({ success: true, itemCount: 1, partial: true });
  });

  it('accepts payloads at the byte budget and rejects the next byte without truncation', () => {
    const payload = { success: true, value: 'é'.repeat(64) };
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');

    const below = createJsonResponse(payload, { payloadBudgetBytes: bytes - 1 });
    const at = createJsonResponse(payload, { payloadBudgetBytes: bytes });
    const above = createJsonResponse(payload, { payloadBudgetBytes: bytes + 1 });

    expect(below.isError).toBe(true);
    expect(JSON.parse(below.content[0].text)).toMatchObject({ errorCode: 'MCP_PAGE_TOO_LARGE' });
    expect(at.isError).toBeUndefined();
    expect(at.content[0].text).toBe(JSON.stringify(payload));
    expect(above.isError).toBeUndefined();
  });

  it('returns an existing artifact reference instead of its oversized body', () => {
    const response = createJsonResponse({
      success: true,
      artifact: { id: 'artifact-1', name: 'export.json', kind: 'json', content: 'x'.repeat(5000) },
    }, { payloadBudgetBytes: 100 });
    const payload = JSON.parse(response.content[0].text);

    expect(response.isError).toBeUndefined();
    expect(payload).toMatchObject({
      success: true,
      exported: true,
      artifact: { id: 'artifact-1', name: 'export.json', kind: 'json' },
    });
    expect(response.content[0].text).not.toContain('x'.repeat(100));
  });

  it('exposes typed error metadata without embedding the message in audit data', () => {
    const error = Object.assign(new Error('private failure detail'), { code: 'BOUNDED_FAILURE' });
    const response = createErrorResponse(error);

    expect(response.isError).toBe(true);
    expect(response._meta?.dotcontext).toMatchObject({ success: false, errorCode: 'BOUNDED_FAILURE' });
    expect(JSON.stringify(response._meta)).not.toContain('private failure detail');
  });
});
