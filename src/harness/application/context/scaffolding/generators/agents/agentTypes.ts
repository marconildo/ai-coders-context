export const AGENT_TYPES = [
  'code-reviewer',
  'bug-fixer',
  'feature-developer',
  'refactoring-specialist',
  'test-writer',
  'documentation-writer',
  'performance-optimizer',
  'security-auditor',
  'backend-specialist',
  'frontend-specialist',
  'architect-specialist',
  'devops-specialist',
  'database-specialist',
  'mobile-specialist'
] as const;

export type AgentType = typeof AGENT_TYPES[number];
