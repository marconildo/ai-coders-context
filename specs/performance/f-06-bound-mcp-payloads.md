# F-06 — Bound MCP payloads

Status: Proposed  
Priority: P0 for redundant parsing, P1 for complete pagination migration  
Boundary owner: MCP gateway and server  
Preventive skill: [bound-mcp-payloads](../../.context/skills/bound-mcp-payloads/SKILL.md)

## Problem

Gateway helpers serialize complete result objects into pretty JSON. The server then parses the same text to derive a small audit summary. Runtime list actions have no cursor and schema fields that can carry large content have no explicit size constraints.

Affected code:

- [response.ts](../../src/mcp/gateway/response.ts)
- [mcpServer.ts](../../src/mcp/server/mcpServer.ts)
- [actionLogger.ts](../../src/mcp/logging/actionLogger.ts)
- [actionService.ts](../../src/harness/application/actions/actionService.ts)

## Goals

- Eliminate response stringify/parse duplication.
- Bound every MCP list response.
- Validate caller-provided sizes and limits.
- Return actionable partial or too-large responses.
- Preserve transport-neutral behavior in harness.

## Non-goals

- Stream arbitrary MCP tool responses over a custom transport.
- Move pagination logic into MCP when it belongs in harness.
- Return raw runtime files as text.

## Structured audit metadata

Use the MCP result _meta field for bounded dotcontext audit metadata:

- success;
- errorCode when present;
- scalar summary keys;
- itemCount;
- partial.

Gateway response helpers construct content and audit metadata from the original result. logToolResponse reads _meta and response.isError; it must never JSON.parse response text.

The dotcontext metadata object must remain below 2 KiB and contain no caller content.

## Pagination

Expose the F-03 cursor contracts for:

- listSessions;
- listTraces;
- listArtifacts;
- listReplays;
- listDatasets;
- listTasks and listHandoffs if their counts can grow without bound.

Defaults and maxima come from harness. MCP Zod schemas enforce integer, positive, bounded limit values. maxEvents defaults to 100 and is capped at 1,000.

## Payload budget

Set a default MCP text payload budget of 1 MiB and an absolute maximum of 4 MiB.

Before final response:

1. serialize compact JSON once;
2. measure UTF-8 bytes;
3. if over budget and pagination is available, return a typed pageTooLarge error with a smaller suggested limit;
4. if content is an export, persist it as a harness artifact and return metadata;
5. never truncate JSON text at an arbitrary byte boundary.

Do not pretty-print responses above 64 KiB. Compact JSON is the default for machine transport.

## Input bounds

Apply schema maxima to:

- content and scalar strings;
- data/output/details object depth and serialized bytes;
- arrays such as evidence, artifacts, sessionIds, and requiredArtifacts;
- regex and glob pattern length;
- maxResults, limit, and maxEvents.

Validate serialized object bytes in application code because Zod shape limits alone are insufficient.

## Compatibility

- Preserve content text for MCP clients.
- Add _meta without requiring clients to consume it.
- Keep existing actions but change unlimited lists to bounded defaults.
- Document how to continue with nextCursor.

## Work breakdown

1. Add audit metadata to response helpers.
2. Remove parseResponsePayload.
3. Add shared input-size validation.
4. Wire F-03 pagination into schemas and gateways.
5. Add single-serialization payload guard.
6. Update MCP README, public docs, and CHANGELOG.

## Acceptance criteria

- logToolResponse performs zero JSON.parse calls on response content.
- A listTraces request without limit returns no more than 100 items.
- Limits above maximum fail schema validation.
- No successful MCP text response exceeds the configured budget without an explicit export reference.
- JSON is serialized exactly once in the normal response path.
- Audit metadata remains below 2 KiB and contains no content fields.
- Existing clients can read success/error content.
- Gateway and server tests cover boundaries at limit-1, limit, and limit+1.
- Package build and smoke tests pass.

## Rollout and rollback

Remove redundant parsing immediately. Ship pagination after F-03. If a client depends on unlimited lists, provide a temporary compatibility option capped by the absolute payload budget; do not restore unlimited defaults.

## Observability

Record responseBytes, serializationMs, itemCount, partial, requestedLimit, appliedLimit, and pageTooLarge. Do not log response bodies.

