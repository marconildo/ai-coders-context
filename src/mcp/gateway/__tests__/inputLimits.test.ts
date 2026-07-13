import { MCP_INPUT_LIMITS, MCPInputLimitError, validateMcpInput } from '../inputLimits';

describe('MCP input limits', () => {
  it('accepts arrays at the limit and rejects limit + 1', () => {
    expect(() => validateMcpInput({ evidence: Array(MCP_INPUT_LIMITS.arrayItems).fill('ok') })).not.toThrow();
    expect(() => validateMcpInput({ evidence: Array(MCP_INPUT_LIMITS.arrayItems + 1).fill('ok') }))
      .toThrow(MCPInputLimitError);
  });

  it('bounds patterns and nested serialized objects', () => {
    expect(() => validateMcpInput({ pattern: 'x'.repeat(MCP_INPUT_LIMITS.patternLength) })).not.toThrow();
    expect(() => validateMcpInput({ pattern: 'x'.repeat(MCP_INPUT_LIMITS.patternLength + 1) }))
      .toThrow(/exceeds/);
    expect(() => validateMcpInput({ data: { value: 'x'.repeat(MCP_INPUT_LIMITS.nestedObjectBytes) } }))
      .toThrow(/serialized bytes/);
  });

  it('rejects excessive object depth', () => {
    let nested: Record<string, unknown> = {};
    for (let index = 0; index <= MCP_INPUT_LIMITS.depth; index += 1) nested = { child: nested };
    expect(() => validateMcpInput(nested)).toThrow(/depth/);
  });
});
