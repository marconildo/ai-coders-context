import { AgentType } from './agentTypes';

export const AGENT_RESPONSIBILITIES: Record<AgentType, string[]> = {
  'code-reviewer': [
    'Review code changes for quality, style, and best practices',
    'Identify potential bugs and security issues',
    'Ensure code follows project conventions',
    'Provide constructive feedback and suggestions'
  ],
  'bug-fixer': [
    'Analyze bug reports and error messages',
    'Identify root causes of issues',
    'Implement targeted fixes with minimal side effects',
    'Test fixes thoroughly before deployment'
  ],
  'feature-developer': [
    'Implement new features according to specifications',
    'Design clean, maintainable code architecture',
    'Integrate features with existing codebase',
    'Write comprehensive tests for new functionality'
  ],
  'refactoring-specialist': [
    'Identify code smells and improvement opportunities',
    'Refactor code while maintaining functionality',
    'Improve code organization and structure',
    'Optimize performance where applicable'
  ],
  'test-writer': [
    'Write comprehensive unit and integration tests',
    'Ensure good test coverage across the codebase',
    'Create test utilities and fixtures',
    'Maintain and update existing tests'
  ],
  'documentation-writer': [
    'Create clear, comprehensive documentation',
    'Update existing documentation as code changes',
    'Write helpful code comments and examples',
    'Maintain README and API documentation'
  ],
  'performance-optimizer': [
    'Identify performance bottlenecks',
    'Optimize code for speed and efficiency',
    'Implement caching strategies',
    'Monitor and improve resource usage'
  ],
  'security-auditor': [
    'Identify security vulnerabilities',
    'Implement security best practices',
    'Review dependencies for security issues',
    'Ensure data protection and privacy compliance'
  ],
  'backend-specialist': [
    'Design and implement server-side architecture',
    'Create and maintain APIs and microservices',
    'Optimize database queries and data models',
    'Implement authentication and authorization',
    'Handle server deployment and scaling'
  ],
  'frontend-specialist': [
    'Design and implement user interfaces',
    'Create responsive and accessible web applications',
    'Optimize client-side performance and bundle sizes',
    'Implement state management and routing',
    'Ensure cross-browser compatibility'
  ],
  'architect-specialist': [
    'Design overall system architecture and patterns',
    'Define technical standards and best practices',
    'Evaluate and recommend technology choices',
    'Plan system scalability and maintainability',
    'Create architectural documentation and diagrams'
  ],
  'devops-specialist': [
    'Design and maintain CI/CD pipelines',
    'Implement infrastructure as code',
    'Configure monitoring and alerting systems',
    'Manage container orchestration and deployments',
    'Optimize cloud resources and cost efficiency'
  ],
  'database-specialist': [
    'Design and optimize database schemas',
    'Create and manage database migrations',
    'Optimize query performance and indexing',
    'Ensure data integrity and consistency',
    'Implement backup and recovery strategies'
  ],
  'mobile-specialist': [
    'Develop native and cross-platform mobile applications',
    'Optimize mobile app performance and battery usage',
    'Implement mobile-specific UI/UX patterns',
    'Handle app store deployment and updates',
    'Integrate push notifications and offline capabilities'
  ]
};
