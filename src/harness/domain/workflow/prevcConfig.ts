/**
 * Role configuration helpers derived from the canonical `PREVC_ROLE_MODEL`.
 *
 * `ROLE_CONFIG` is intentionally **not exported**. It is a narrow
 * projection of `PREVC_ROLE_MODEL` used only by the helpers in this file
 * (`getRoleConfig`).
 * External callers should depend on those helpers or on `PREVC_ROLE_MODEL`
 * directly from `./registries/prevcModel`, so there is a single source of
 * truth for role metadata.
 *
 * @internal
 */

import { PrevcRole, RoleDefinition } from './types';
import {
  PREVC_ROLE_MODEL,
  PREVC_ROLE_SEQUENCE,
} from './registries/prevcModel';

const ROLE_CONFIG: Record<PrevcRole, RoleDefinition> = Object.fromEntries(
  PREVC_ROLE_SEQUENCE.map((role) => {
    const definition = PREVC_ROLE_MODEL[role];
    const phase = definition.phases.length === 1
      ? definition.phases[0]
      : [...definition.phases];

    return [role, {
      phase,
      responsibilities: [...definition.responsibilities],
      outputs: [...definition.outputs],
      specialists: [...definition.specialists],
    }];
  })
) as Record<PrevcRole, RoleDefinition>;

/**
 * Get the configuration for a specific role
 */
export function getRoleConfig(role: PrevcRole): RoleDefinition {
  return ROLE_CONFIG[role];
}
