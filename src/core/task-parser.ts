/**
 * Task Parser - Converts natural language to structured browsing intent
 */

import type { BrowsingIntent, ActionType } from './types.js';

// Domain patterns for common tasks
const DOMAIN_PATTERNS: Record<string, RegExp[]> = {
  search: [/google\.com/, /bing\.com/, /duckduckgo\.com/, /brave\.com/],
  shopping: [/amazon\.com/, /ebay\.com/, /newegg\.com/, /bestbuy\.com/, /walmart\.com/],
  news: [/cnn\.com/, /bbc\.com/, /reuters\.com/, /nytimes\.com/],
  social: [/twitter\.com/, /x\.com/, /facebook\.com/, /linkedin\.com/, /reddit\.com/],
  docs: [/github\.com/, /stackoverflow\.com/, /docs\./, /wiki/],
};

// Task type inference patterns
const TASK_PATTERNS: Array<{ pattern: RegExp; taskType: BrowsingIntent['taskType'] }> = [
  { pattern: /\b(search|find|look up|lookup|google)\b/i, taskType: 'search' },
  { pattern: /\b(price|cost|buy|purchase|order)\b/i, taskType: 'purchase' },
  { pattern: /\b(extract|scrape|get the|grab|pull)\b/i, taskType: 'extract' },
  { pattern: /\b(log ?in|sign ?in|authenticate)\b/i, taskType: 'login' },
  { pattern: /\b(check|monitor|watch|track)\b/i, taskType: 'monitor' },
  { pattern: /\b(click|fill|submit|interact)\b/i, taskType: 'interact' },
];

// Action permissions by task type
const TASK_ACTIONS: Record<BrowsingIntent['taskType'], ActionType[]> = {
  search: ['navigate', 'type', 'click', 'scroll', 'extract'],
  extract: ['navigate', 'scroll', 'extract', 'screenshot'],
  monitor: ['navigate', 'scroll', 'extract', 'screenshot', 'wait'],
  interact: ['navigate', 'click', 'scroll', 'type', 'extract'],
  purchase: ['navigate', 'click', 'scroll', 'type', 'extract'], // No auto-submit for payments
  login: ['navigate', 'click', 'type'], // Limited - sensitive
};

// Default constraints by task type
const TASK_CONSTRAINTS: Record<BrowsingIntent['taskType'], { maxDepth: number; timeout: number }> = {
  search: { maxDepth: 3, timeout: 30000 },
  extract: { maxDepth: 5, timeout: 60000 },
  monitor: { maxDepth: 2, timeout: 120000 },
  interact: { maxDepth: 5, timeout: 60000 },
  purchase: { maxDepth: 10, timeout: 180000 },
  login: { maxDepth: 3, timeout: 30000 },
};

export interface ParseOptions {
  /** Additional allowed domains */
  extraDomains?: string[];
  
  /** Override max depth */
  maxDepth?: number;
  
  /** Override timeout */
  timeout?: number;
  
  /** Known sensitive data patterns */
  sensitivePatterns?: RegExp[];
}

/**
 * Parse a natural language request into a structured browsing intent
 */
export function parseIntent(request: string, options: ParseOptions = {}): BrowsingIntent {
  const taskType = inferTaskType(request);
  const domains = extractDomains(request, options.extraDomains);
  const constraints = TASK_CONSTRAINTS[taskType];
  
  return {
    goal: summarizeGoal(request, taskType),
    taskType,
    allowedDomains: domains,
    allowedActions: TASK_ACTIONS[taskType],
    sensitiveData: detectSensitiveData(request, options.sensitivePatterns),
    maxDepth: options.maxDepth ?? constraints.maxDepth,
    timeout: options.timeout ?? constraints.timeout,
    originalRequest: request,
  };
}

/**
 * Infer task type from request text
 */
function inferTaskType(request: string): BrowsingIntent['taskType'] {
  for (const { pattern, taskType } of TASK_PATTERNS) {
    if (pattern.test(request)) {
      return taskType;
    }
  }
  return 'extract'; // Default to read-only extraction
}

/**
 * Extract allowed domains from request
 */
function extractDomains(request: string, extraDomains?: string[]): string[] {
  const domains = new Set<string>(extraDomains ?? []);
  
  // Extract explicit URLs
  const urlPattern = /https?:\/\/([a-zA-Z0-9.-]+)/g;
  let match;
  while ((match = urlPattern.exec(request)) !== null) {
    domains.add(match[1]);
  }
  
  // Extract domain mentions
  const domainPattern = /\b([a-zA-Z0-9-]+\.(com|org|net|io|ai|co|edu|gov))\b/g;
  while ((match = domainPattern.exec(request)) !== null) {
    domains.add(match[1]);
  }
  
  // Add related domains for known sites
  for (const domain of [...domains]) {
    // Allow www variants
    if (!domain.startsWith('www.')) {
      domains.add(`www.${domain}`);
    }
    // Allow subdomains for known patterns
    if (domain.includes('github.com')) {
      domains.add('raw.githubusercontent.com');
      domains.add('api.github.com');
    }
  }
  
  // If no domains found, allow search engines for search tasks
  if (domains.size === 0) {
    return ['www.google.com', 'google.com'];
  }
  
  return [...domains];
}

/**
 * Detect potentially sensitive data in request
 */
function detectSensitiveData(request: string, extraPatterns?: RegExp[]): string[] {
  const sensitive: string[] = [];
  
  const patterns = [
    { pattern: /\b\d{3}-\d{2}-\d{4}\b/, name: 'SSN' },
    { pattern: /\b\d{16}\b/, name: 'credit_card' },
    { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, name: 'email' },
    { pattern: /\bpassword\b/i, name: 'password' },
    { pattern: /\bapi[_-]?key\b/i, name: 'api_key' },
    { pattern: /\bsecret\b/i, name: 'secret' },
    ...(extraPatterns?.map(p => ({ pattern: p, name: 'custom' })) ?? []),
  ];
  
  for (const { pattern, name } of patterns) {
    if (pattern.test(request)) {
      sensitive.push(name);
    }
  }
  
  return sensitive;
}

/**
 * Generate a concise goal description
 */
function summarizeGoal(request: string, taskType: BrowsingIntent['taskType']): string {
  // Simple truncation for now - could use LLM for better summaries
  const maxLength = 100;
  const cleaned = request.replace(/\s+/g, ' ').trim();
  
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  
  return cleaned.substring(0, maxLength - 3) + '...';
}

/**
 * Validate that an intent is safe to execute
 */
export function validateIntent(intent: BrowsingIntent): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  
  // Check for dangerous combinations
  if (intent.taskType === 'login' && intent.sensitiveData.includes('password')) {
    issues.push('Login task with password in request - credentials should not be in request text');
  }
  
  if (intent.taskType === 'purchase' && intent.sensitiveData.includes('credit_card')) {
    issues.push('Purchase task with credit card in request - payment info should not be in request text');
  }
  
  // Check domain allowlist isn't too broad
  if (intent.allowedDomains.length === 0) {
    issues.push('No domains specified - cannot execute without domain allowlist');
  }
  
  // Check for wildcard-like domains
  for (const domain of intent.allowedDomains) {
    if (domain.length < 4 || domain === '*') {
      issues.push(`Domain too broad: ${domain}`);
    }
  }
  
  // Check timeout is reasonable
  if (intent.timeout > 300000) {
    issues.push('Timeout exceeds 5 minutes - consider breaking into smaller tasks');
  }
  
  return {
    valid: issues.length === 0,
    issues,
  };
}
