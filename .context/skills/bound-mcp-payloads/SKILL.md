---
name: bound-mcp-payloads
description: Implement or review bounded MCP inputs and responses. Use for gateway response helpers, MCP Zod schemas, list actions, cursor pagination, maxEvents, JSON serialization, audit logging, response metadata, artifact exports, or payload-size and client-compatibility changes.
---

# Bound MCP Payloads

Serialize once, paginate at the source, and keep transport metadata small.

## Workflow

1. Identify the harness result cardinality before shaping the MCP response.
2. Reuse harness cursor pagination; never paginate only after serialization.
3. Set Zod defaults and maxima for counts, string lengths, array lengths, and patterns.
4. Add serialized-byte validation for nested unknown objects.
5. Derive bounded audit metadata before serialization.
6. Serialize response content once and measure UTF-8 bytes.
7. Return a smaller-page hint or artifact reference when the response exceeds budget.
8. Test boundary values and existing client behavior.

## Required invariants

- Never JSON.parse response text for logging.
- Never truncate JSON at an arbitrary byte position.
- Never pretty-print large machine payloads.
- Never expose an unlimited list action.
- Never put content, prompts, messages, or secrets in audit metadata.
- Keep MCP adaptation thin; pagination belongs to harness.
- Preserve content text for clients that ignore _meta.

## Response choices

Use, in order:

1. a normal bounded page;
2. a smaller suggested page after pageTooLarge;
3. an artifact/export reference for intentionally large output;
4. a typed rejection for oversized input.

Do not increase the payload budget to accommodate an unbounded API.

## Dotcontext routing

- Keep reusable data limits in harness.
- Keep schema and response shaping in src/mcp/gateway or src/mcp/server.
- Update MCP docs and package smoke tests for public contract changes.
- Follow [F-06](../../../specs/performance/f-06-bound-mcp-payloads.md).

## Review gate

Require evidence that normal responses serialize once, list defaults are bounded, limit+1 is rejected, audit metadata stays content-free, and no successful response silently exceeds budget.

