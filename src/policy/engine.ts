/**
 * Policy Engine - Enforces security constraints on browser actions
 */

import type {
  Policy,
  PolicyRule,
  PolicyDecision,
  PolicySource,
  BrowsingIntent,
  BrowserAction,
  ExecutionContext,
  ActionType,
} from '../core/types.js';

// ============================================================================
// Static Policies (Hardcoded Security Rules)
// ============================================================================

const STATIC_POLICIES: PolicyRule[] = [
  // Never auto-submit payments
  {
    id: 'static:no-auto-payment',
    source: 'static',
    scope: { actions: ['click', 'type'] },
    effect: 'deny',
    description: 'Block automatic payment submission - requires user confirmation',
    priority: 0,
  },
  
  // Never enter credentials on non-HTTPS
  {
    id: 'static:https-only-credentials',
    source: 'static',
    scope: { taskTypes: ['login'] },
    effect: 'deny',
    description: 'Block credential entry on non-HTTPS sites',
    priority: 0,
  },
  
  // Never download executables
  {
    id: 'static:no-executable-download',
    source: 'static',
    scope: { actions: ['click', 'navigate'] },
    effect: 'deny',
    description: 'Block download of executable files',
    priority: 0,
  },
  
  // Never navigate to known malicious domains
  {
    id: 'static:block-malicious-domains',
    source: 'static',
    scope: {},
    effect: 'deny',
    description: 'Block navigation to known malicious domains',
    priority: 0,
  },
  
  // Require confirmation for form submissions
  {
    id: 'static:confirm-form-submit',
    source: 'static',
    scope: { actions: ['click'] },
    effect: 'confirm',
    description: 'Require confirmation for form submissions',
    priority: 10,
  },
  
  // Require confirmation for external navigation
  {
    id: 'static:confirm-external-nav',
    source: 'static',
    scope: { actions: ['navigate', 'click'] },
    effect: 'confirm',
    description: 'Require confirmation for navigation outside allowed domains',
    priority: 10,
  },
];

// Known malicious domain patterns (would be loaded from threat intel in production)
const MALICIOUS_DOMAIN_PATTERNS = [
  /phishing\./i,
  /malware\./i,
  /\.ru$/,  // Overly broad - just for demo
  /bit\.ly/,  // URL shorteners need special handling
  /tinyurl\.com/,
];

// Executable file patterns
const EXECUTABLE_PATTERNS = [
  /\.exe$/i,
  /\.msi$/i,
  /\.dmg$/i,
  /\.pkg$/i,
  /\.app$/i,
  /\.bat$/i,
  /\.cmd$/i,
  /\.sh$/i,
  /\.ps1$/i,
];

// Payment-related selectors/text
const PAYMENT_INDICATORS = [
  /pay\s*now/i,
  /pay\s*\$?\d/i,        // "Pay $100", "Pay 50"
  /place\s*order/i,
  /complete\s*purchase/i,
  /submit\s*payment/i,
  /buy\s*now/i,
  /buy\s*for\s*\$/i,     // "Buy for $X"
  /checkout/i,
  /confirm\s*payment/i,
  /process\s*payment/i,
];

// ============================================================================
// Policy Implementation
// ============================================================================

export class PolicyEngine implements Policy {
  private rules: PolicyRule[] = [];
  private intent?: BrowsingIntent;
  
  constructor(intent?: BrowsingIntent) {
    this.intent = intent;
    this.rules = [...STATIC_POLICIES];
    
    if (intent) {
      this.rules.push(...this.deriveTaskPolicies(intent));
    }
    
    // Sort by priority (lower = higher priority)
    this.rules.sort((a, b) => a.priority - b.priority);
  }
  
  /**
   * Derive policies from task intent
   */
  private deriveTaskPolicies(intent: BrowsingIntent): PolicyRule[] {
    const derived: PolicyRule[] = [];
    
    // Domain allowlist
    derived.push({
      id: 'task:domain-allowlist',
      source: 'task',
      scope: { domains: intent.allowedDomains },
      effect: 'allow',
      description: `Allow navigation to: ${intent.allowedDomains.join(', ')}`,
      priority: 5,
    });
    
    // Deny navigation outside allowlist
    derived.push({
      id: 'task:domain-denylist',
      source: 'task',
      scope: {},
      effect: 'deny',
      description: 'Deny navigation outside allowed domains',
      priority: 100,
    });
    
    // Action allowlist
    derived.push({
      id: 'task:action-allowlist',
      source: 'task',
      scope: { actions: intent.allowedActions },
      effect: 'allow',
      description: `Allow actions: ${intent.allowedActions.join(', ')}`,
      priority: 5,
    });
    
    // Task-specific rules
    if (intent.taskType === 'search' || intent.taskType === 'extract') {
      // Read-only tasks shouldn't submit forms (except search)
      derived.push({
        id: 'task:read-only-no-submit',
        source: 'task',
        scope: { actions: ['click'] },
        effect: 'confirm',
        description: 'Read-only task - confirm before form submission',
        priority: 20,
      });
    }
    
    if (intent.taskType === 'login') {
      // Extra caution for login flows
      derived.push({
        id: 'task:login-single-site',
        source: 'task',
        scope: {},
        effect: 'deny',
        description: 'Login task - deny redirects to other domains',
        priority: 5,
      });
    }
    
    return derived;
  }
  
  /**
   * Add site-authored policies (from page headers/meta tags)
   */
  addSitePolicies(policies: PolicyRule[]): void {
    for (const policy of policies) {
      this.rules.push({ ...policy, source: 'site' });
    }
    this.rules.sort((a, b) => a.priority - b.priority);
  }
  
  /**
   * Check if an action is allowed in the current context
   */
  allows(action: BrowserAction, context: ExecutionContext): PolicyDecision {
    // Check static security rules first
    const securityCheck = this.checkSecurityRules(action, context);
    if (!securityCheck.allowed) {
      return securityCheck;
    }
    
    // Check domain allowlist
    if (action.type === 'navigate' && action.target) {
      const domainCheck = this.checkDomainAllowed(action.target);
      if (!domainCheck.allowed) {
        return domainCheck;
      }
    }
    
    // Check action allowlist
    if (this.intent && !this.intent.allowedActions.includes(action.type)) {
      return {
        allowed: false,
        effect: 'deny',
        reason: `Action '${action.type}' not allowed for this task`,
      };
    }
    
    // Default allow
    return { allowed: true, effect: 'allow' };
  }
  
  /**
   * Check if entire intent is allowed
   */
  allowsIntent(intent: BrowsingIntent): PolicyDecision {
    // Check for obviously dangerous intents
    if (intent.sensitiveData.length > 0 && intent.taskType === 'extract') {
      return {
        allowed: false,
        effect: 'deny',
        reason: 'Cannot extract data when sensitive information is involved',
      };
    }
    
    // Check domains aren't malicious
    for (const domain of intent.allowedDomains) {
      if (this.isMaliciousDomain(domain)) {
        return {
          allowed: false,
          effect: 'deny',
          reason: `Domain '${domain}' is on malicious domain list`,
        };
      }
    }
    
    return { allowed: true, effect: 'allow' };
  }
  
  /**
   * Check security-critical rules
   */
  private checkSecurityRules(action: BrowserAction, context: ExecutionContext): PolicyDecision {
    // Check for executable downloads
    if (action.target && EXECUTABLE_PATTERNS.some(p => p.test(action.target!))) {
      return {
        allowed: false,
        effect: 'deny',
        matchedRule: STATIC_POLICIES.find(r => r.id === 'static:no-executable-download'),
        reason: 'Executable download blocked',
      };
    }
    
    // Check for payment actions
    if (action.description && PAYMENT_INDICATORS.some(p => p.test(action.description))) {
      return {
        allowed: false,
        effect: 'deny',
        matchedRule: STATIC_POLICIES.find(r => r.id === 'static:no-auto-payment'),
        reason: 'Payment action requires user confirmation',
      };
    }
    
    // Check HTTPS for login
    if (this.intent?.taskType === 'login' && !context.currentUrl.startsWith('https://')) {
      return {
        allowed: false,
        effect: 'deny',
        matchedRule: STATIC_POLICIES.find(r => r.id === 'static:https-only-credentials'),
        reason: 'Credentials cannot be entered on non-HTTPS sites',
      };
    }
    
    return { allowed: true, effect: 'allow' };
  }
  
  /**
   * Check if domain is in allowlist
   */
  private checkDomainAllowed(url: string): PolicyDecision {
    if (!this.intent) {
      return { allowed: true, effect: 'allow' };
    }
    
    try {
      const urlObj = new URL(url);
      const domain = urlObj.hostname;
      
      // Check malicious first
      if (this.isMaliciousDomain(domain)) {
        return {
          allowed: false,
          effect: 'deny',
          reason: `Navigation to malicious domain '${domain}' blocked`,
        };
      }
      
      // Check allowlist
      const allowed = this.intent.allowedDomains.some(d => 
        domain === d || domain.endsWith(`.${d}`)
      );
      
      if (!allowed) {
        return {
          allowed: false,
          effect: 'deny',
          reason: `Domain '${domain}' not in allowlist: ${this.intent.allowedDomains.join(', ')}`,
        };
      }
      
      return { allowed: true, effect: 'allow' };
    } catch {
      // Invalid URL
      return {
        allowed: false,
        effect: 'deny',
        reason: `Invalid URL: ${url}`,
      };
    }
  }
  
  /**
   * Check if domain matches malicious patterns
   */
  private isMaliciousDomain(domain: string): boolean {
    return MALICIOUS_DOMAIN_PATTERNS.some(p => p.test(domain));
  }
  
  /**
   * Get all rules for inspection
   */
  getRules(): PolicyRule[] {
    return [...this.rules];
  }
}

/**
 * Parse site-authored policies from HTML meta tags
 */
export function parseSitePolicies(html: string, domain: string): PolicyRule[] {
  const policies: PolicyRule[] = [];
  
  // Look for ai-agent-policy meta tag
  const metaMatch = html.match(/<meta\s+name=["']ai-agent-policy["']\s+content=["']([^"']+)["']/i);
  
  if (metaMatch) {
    const directives = metaMatch[1].split(',').map(d => d.trim().toLowerCase());
    
    for (const directive of directives) {
      switch (directive) {
        case 'no-form-submit':
          policies.push({
            id: `site:${domain}:no-form-submit`,
            source: 'site',
            scope: { domains: [domain], actions: ['click'] },
            effect: 'deny',
            description: `Site ${domain} disallows form submission by AI agents`,
            priority: 3,
          });
          break;
          
        case 'read-only':
          policies.push({
            id: `site:${domain}:read-only`,
            source: 'site',
            scope: { domains: [domain], actions: ['click', 'type'] },
            effect: 'deny',
            description: `Site ${domain} is read-only for AI agents`,
            priority: 3,
          });
          break;
          
        case 'no-ai-agents':
          policies.push({
            id: `site:${domain}:no-ai-agents`,
            source: 'site',
            scope: { domains: [domain] },
            effect: 'deny',
            description: `Site ${domain} disallows AI agents entirely`,
            priority: 1,
          });
          break;
      }
    }
  }
  
  return policies;
}
