import { SKILL_TO_PHASES, BuiltInSkillType, isBuiltInSkill } from '../../../../../../domain/workflow/skills';
import { PrevcPhase } from '../../../../../../domain/workflow/types';

/**
 * Get default phases for a skill name
 */
export function getDefaultPhases(skillName: string): PrevcPhase[] {
  if (isBuiltInSkill(skillName)) {
    return SKILL_TO_PHASES[skillName as BuiltInSkillType];
  }
  return ['E']; // Default to Execution phase
}
