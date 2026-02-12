/**
 * HTTP-Level Request Filter
 * 
 * Based on ceLLMate's approach: intercept HTTP requests and enforce
 * policies based on URL patterns, methods, and body content.
 * 
 * This complements the DAG-based action orchestration by providing
 * a lower-level safety net.
 */

import type { BrowsingIntent } from '../core/types.js';

// ============================================================================
// Sitemap Types (ceLLMate format)
// ============================================================================

export interface SitemapEntry {
  /** Category for grouping */
  category: string;
  
  /** Human-readable action name */
  semantic_action: string;
  
  /** URL pattern (supports {param} and * wildcards) */
  url: string;
  
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  
  /** Body pattern to match (for POST/PUT) */
  body: Record<string, unknown>;
  
  /** Optional regex for more precise matching */
  regex?: string;
  
  /** Resource types to match (main_frame, xmlhttprequest, etc.) */
  resource_types?: string[];
  
  /** Child requests that are part of this action */
  children?: Array<{
    method: string;
    url: string;
    body?: Record<string, unknown>;
  }>;
  
  /** Example URLs for documentation */
  example_urls?: string[];
  
  /** Priority (lower = matched first) */
  priority: number;
}

export interface SitePolicy {
  /** Policy name */
  name: string;
  
  /** Description */
  description: string;
  
  /** Default behavior: 'deny' | 'allow' | 'allow_public' */
  default: 'deny' | 'allow' | 'allow_public';
  
  /** Primary domains this policy applies to */
  domains: string[];
  
  /** Additional allowed domains (for CDNs, APIs, etc.) */
  allowed_domains: string[];
  
  /** Specific requests to always allow */
  allowed_requests: Array<{
    url: string;
    method?: string;
  }>;
  
  /** Active rules (references to rule files) */
  rules: string[];
}

export interface PolicyRule {
  /** Allow or deny */
  effect: 'allow' | 'deny' | 'allow_public';
  
  /** Semantic actions this rule applies to */
  action: string[];
  
  /** Whether this is a sensitive action (requires extra confirmation) */
  sensitive: boolean;
  
  /** Human-readable description */
  description: string;
}

// ============================================================================
// HTTP Filter
// ============================================================================

export interface HttpRequest {
  url: string;
  method: string;
  body?: Record<string, unknown> | string;
  headers?: Record<string, string>;
  resourceType?: string;
}

export interface FilterDecision {
  allowed: boolean;
  action: 'allow' | 'deny' | 'allow_public';
  reason: string;
  matchedEntry?: SitemapEntry;
  matchedRule?: PolicyRule;
  stripCookies?: boolean;
}

export class HttpFilter {
  private sitemaps: Map<string, SitemapEntry[]> = new Map();
  private policies: Map<string, SitePolicy> = new Map();
  private rules: Map<string, PolicyRule[]> = new Map();
  private predictedAllowlist: Set<string> = new Set();
  private predictedAllowlistActive: boolean = false;
  
  constructor() {}
  
  /**
   * Load a sitemap for a domain
   */
  loadSitemap(domain: string, entries: SitemapEntry[]): void {
    // Sort by priority
    const sorted = [...entries].sort((a, b) => a.priority - b.priority);
    this.sitemaps.set(domain, sorted);
  }
  
  /**
   * Load a policy for a domain
   */
  loadPolicy(domain: string, policy: SitePolicy): void {
    this.policies.set(domain, policy);
  }
  
  /**
   * Load rules for a domain
   */
  loadRules(domain: string, rules: PolicyRule[]): void {
    this.rules.set(domain, rules);
  }
  
  /**
   * Set predicted allowlist from task intent
   */
  setPredictedAllowlist(domains: string[], active: boolean = true): void {
    this.predictedAllowlist = new Set(domains);
    this.predictedAllowlistActive = active;
  }
  
  /**
   * Filter an HTTP request
   */
  filter(request: HttpRequest, currentDomain?: string): FilterDecision {
    const destHost = this.extractHostname(request.url);
    const method = request.method.toUpperCase();
    
    // Layer 1: Predicted allowlist
    if (this.predictedAllowlistActive) {
      if (!this.predictedAllowlist.has(destHost)) {
        // Check if current domain's policy allows this destination
        if (!this.policyAllowsDomain(currentDomain, destHost)) {
          return {
            allowed: false,
            action: 'deny',
            reason: `Domain '${destHost}' not in predicted allowlist`,
          };
        }
      }
    }
    
    // Layer 2: Check if destination has a policy
    const destPolicy = this.findPolicy(destHost);
    const currentPolicy = currentDomain ? this.findPolicy(currentDomain) : undefined;
    
    if (!destPolicy) {
      // No policy for destination - check if current policy allows it
      if (!currentPolicy) {
        return {
          allowed: false,
          action: 'deny',
          reason: `No policy for domain '${destHost}' and no current context`,
        };
      }
      
      if (!this.policyAllowsDomain(currentDomain, destHost)) {
        return {
          allowed: false,
          action: 'deny',
          reason: `Domain '${destHost}' not allowed by current policy`,
        };
      }
    }
    
    // Layer 3: Match against sitemap and rules
    const policy = destPolicy || currentPolicy!;
    const sitemap = this.findSitemap(destHost) || this.findSitemap(currentDomain!);
    
    if (sitemap) {
      const match = this.matchRequest(request, sitemap);
      
      if (match) {
        // Found a sitemap entry - check rules
        const rules = this.rules.get(policy.domains[0]) || [];
        const rule = this.findMatchingRule(match.semantic_action, rules);
        
        if (rule) {
          return {
            allowed: rule.effect !== 'deny',
            action: rule.effect,
            reason: rule.description,
            matchedEntry: match,
            matchedRule: rule,
            stripCookies: rule.effect === 'allow_public',
          };
        }
        
        // No specific rule - use default
        return {
          allowed: policy.default !== 'deny',
          action: policy.default,
          reason: `Default policy: ${policy.default}`,
          matchedEntry: match,
          stripCookies: policy.default === 'allow_public',
        };
      }
    }
    
    // No sitemap match - check allowed_requests
    if (policy.allowed_requests.some(ar => 
      request.url.startsWith(ar.url) && (!ar.method || ar.method === method)
    )) {
      return {
        allowed: true,
        action: 'allow',
        reason: 'Explicitly allowed request',
      };
    }
    
    // Fall back to default
    return {
      allowed: policy.default !== 'deny',
      action: policy.default,
      reason: `Default policy: ${policy.default}`,
      stripCookies: policy.default === 'allow_public',
    };
  }
  
  /**
   * Generate predicted allowlist from browsing intent
   */
  static predictAllowlistFromIntent(intent: BrowsingIntent): string[] {
    const domains = new Set(intent.allowedDomains);
    
    // Add common CDN/API domains for known sites
    for (const domain of intent.allowedDomains) {
      if (domain.includes('github.com')) {
        domains.add('githubusercontent.com');
        domains.add('github.githubassets.com');
        domains.add('api.github.com');
      }
      if (domain.includes('gitlab.com')) {
        domains.add('gitlab.net');
        domains.add('gl-product-analytics.com');
      }
      // Add more site-specific CDNs as needed
    }
    
    return [...domains];
  }
  
  // ============================================================================
  // Private Helpers
  // ============================================================================
  
  private extractHostname(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }
  
  private findPolicy(hostname: string): SitePolicy | undefined {
    for (const [domain, policy] of this.policies) {
      if (this.domainMatches(domain, hostname)) {
        return policy;
      }
    }
    return undefined;
  }
  
  private findSitemap(hostname: string): SitemapEntry[] | undefined {
    for (const [domain, sitemap] of this.sitemaps) {
      if (this.domainMatches(domain, hostname)) {
        return sitemap;
      }
    }
    return undefined;
  }
  
  private domainMatches(policyDomain: string, hostname: string): boolean {
    if (!policyDomain || !hostname) return false;
    if (policyDomain === hostname) return true;
    return hostname.endsWith(`.${policyDomain}`);
  }
  
  private policyAllowsDomain(currentDomain: string | undefined, destHost: string): boolean {
    if (!currentDomain) return false;
    const policy = this.findPolicy(currentDomain);
    if (!policy) return false;
    
    return policy.allowed_domains.some(ad => this.domainMatches(ad, destHost));
  }
  
  private matchRequest(request: HttpRequest, sitemap: SitemapEntry[]): SitemapEntry | undefined {
    const method = request.method.toUpperCase();
    const body = typeof request.body === 'string' ? this.parseBody(request.body) : request.body;
    
    for (const entry of sitemap) {
      // Check method
      if (entry.method && entry.method !== method) continue;
      
      // Check URL pattern
      const regex = this.compilePattern(entry.regex || entry.url);
      if (!regex.test(request.url)) continue;
      
      // Check body pattern if specified
      if (entry.body && Object.keys(entry.body).length > 0) {
        if (!body || !this.bodyContains(entry.body, body)) continue;
      }
      
      // Check resource type if specified
      if (entry.resource_types && entry.resource_types.length > 0) {
        if (!request.resourceType || !entry.resource_types.includes(request.resourceType)) {
          continue;
        }
      }
      
      return entry;
    }
    
    return undefined;
  }
  
  private findMatchingRule(semanticAction: string, rules: PolicyRule[]): PolicyRule | undefined {
    return rules.find(r => r.action.includes(semanticAction));
  }
  
  private compilePattern(pattern: string): RegExp {
    // Escape regex chars, then convert {param} and * to regex
    let escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    escaped = escaped
      .replace(/\\\{[a-zA-Z_][a-zA-Z0-9_]*\\\}/g, '([^/]+)')
      .replace(/\\\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  }
  
  private parseBody(body: string): Record<string, unknown> | undefined {
    try {
      return JSON.parse(body);
    } catch {
      // Try URL-encoded
      try {
        const params = new URLSearchParams(body);
        const obj: Record<string, unknown> = {};
        for (const [k, v] of params) {
          obj[k] = v;
        }
        return obj;
      } catch {
        return undefined;
      }
    }
  }
  
  private bodyContains(pattern: Record<string, unknown>, target: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(pattern)) {
      if (!(key in target)) return false;
      
      if (typeof value === 'object' && value !== null) {
        if (typeof target[key] !== 'object' || target[key] === null) return false;
        if (!this.bodyContains(value as Record<string, unknown>, target[key] as Record<string, unknown>)) {
          return false;
        }
      } else if (target[key] !== value) {
        return false;
      }
    }
    return true;
  }
}

/**
 * Create an HTTP filter from an intent (for web_fetch protection)
 */
export function createFilterFromIntent(intent: BrowsingIntent): HttpFilter {
  const filter = new HttpFilter();
  
  // Set up predicted allowlist
  const allowlist = HttpFilter.predictAllowlistFromIntent(intent);
  filter.setPredictedAllowlist(allowlist, true);
  
  // Create a basic policy for each allowed domain
  for (const domain of intent.allowedDomains) {
    filter.loadPolicy(domain, {
      name: `auto_${domain}`,
      description: `Auto-generated policy for ${domain}`,
      default: intent.taskType === 'extract' ? 'allow_public' : 'allow',
      domains: [domain],
      allowed_domains: allowlist,
      allowed_requests: [],
      rules: [],
    });
  }
  
  return filter;
}
