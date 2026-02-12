/**
 * Web Fetch Guard
 * 
 * Protects OpenClaw's web_fetch tool by filtering requests
 * through the HTTP filter before they execute.
 */

import { HttpFilter, createFilterFromIntent } from '../policy/http-filter.js';
import { parseIntent, validateIntent } from '../core/task-parser.js';
import type { BrowsingIntent } from '../core/types.js';
import type { HttpRequest, FilterDecision } from '../policy/http-filter.js';

// ============================================================================
// Types
// ============================================================================

export interface WebFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
}

export interface WebFetchGuardConfig {
  /** Enable/disable the guard */
  enabled: boolean;
  
  /** Mode: 'warn' logs issues but allows, 'block' prevents execution */
  mode: 'warn' | 'block';
  
  /** Domains that bypass filtering entirely */
  trustedDomains: string[];
  
  /** Whether to strip cookies for all requests (privacy mode) */
  stripCookies: boolean;
  
  /** Log callback for debugging */
  onLog?: (message: string) => void;
}

export interface GuardResult {
  allowed: boolean;
  request: WebFetchRequest;
  decision: FilterDecision;
  modified: boolean;
}

// ============================================================================
// Web Fetch Guard
// ============================================================================

export class WebFetchGuard {
  private config: WebFetchGuardConfig;
  private filter: HttpFilter;
  private currentIntent?: BrowsingIntent;
  
  constructor(config: Partial<WebFetchGuardConfig> = {}) {
    this.config = {
      enabled: true,
      mode: 'block',
      trustedDomains: [],
      stripCookies: true,
      ...config,
    };
    
    this.filter = new HttpFilter();
  }
  
  /**
   * Set the current browsing intent (derived from user request)
   */
  setIntent(intent: BrowsingIntent): void {
    this.currentIntent = intent;
    
    // Recreate filter with new intent
    this.filter = createFilterFromIntent(intent);
    
    this.log(`Intent set: ${intent.taskType} on ${intent.allowedDomains.join(', ')}`);
  }
  
  /**
   * Set intent from natural language request
   */
  setIntentFromRequest(userRequest: string): { valid: boolean; issues: string[] } {
    const intent = parseIntent(userRequest);
    const validation = validateIntent(intent);
    
    if (validation.valid) {
      this.setIntent(intent);
    }
    
    return validation;
  }
  
  /**
   * Check if a web_fetch request should be allowed
   */
  check(request: WebFetchRequest): GuardResult {
    if (!this.config.enabled) {
      return {
        allowed: true,
        request,
        decision: { allowed: true, action: 'allow', reason: 'Guard disabled' },
        modified: false,
      };
    }
    
    // Check trusted domains first
    const domain = this.extractDomain(request.url);
    if (this.config.trustedDomains.includes(domain)) {
      this.log(`Trusted domain bypass: ${domain}`);
      return {
        allowed: true,
        request,
        decision: { allowed: true, action: 'allow', reason: 'Trusted domain' },
        modified: false,
      };
    }
    
    // Convert to HTTP request format
    const httpRequest: HttpRequest = {
      url: request.url,
      method: request.method || 'GET',
      headers: request.headers,
      body: request.body,
    };
    
    // Run through filter
    const decision = this.filter.filter(httpRequest);
    
    this.log(`Filter decision for ${request.url}: ${decision.action} - ${decision.reason}`);
    
    // Handle decision
    if (!decision.allowed) {
      if (this.config.mode === 'warn') {
        this.log(`WARNING: Would block ${request.url} - ${decision.reason}`);
        return {
          allowed: true,
          request,
          decision,
          modified: false,
        };
      }
      
      return {
        allowed: false,
        request,
        decision,
        modified: false,
      };
    }
    
    // Modify request if needed
    let modifiedRequest = request;
    let modified = false;
    
    if (decision.stripCookies || this.config.stripCookies) {
      modifiedRequest = this.stripCookiesFromRequest(request);
      modified = true;
      this.log(`Stripped cookies from request to ${request.url}`);
    }
    
    return {
      allowed: true,
      request: modifiedRequest,
      decision,
      modified,
    };
  }
  
  /**
   * Convenience method to guard a fetch and return the modified request
   * Throws if blocked
   */
  guard(request: WebFetchRequest): WebFetchRequest {
    const result = this.check(request);
    
    if (!result.allowed) {
      throw new WebFetchBlockedError(
        request.url,
        result.decision.reason || 'Request blocked by Browser Guard'
      );
    }
    
    return result.request;
  }
  
  /**
   * Strip cookies from request headers
   */
  private stripCookiesFromRequest(request: WebFetchRequest): WebFetchRequest {
    const headers = { ...request.headers };
    
    // Remove cookie-related headers
    delete headers['cookie'];
    delete headers['Cookie'];
    delete headers['authorization'];
    delete headers['Authorization'];
    
    return {
      ...request,
      headers,
    };
  }
  
  /**
   * Extract domain from URL
   */
  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }
  
  /**
   * Log a message
   */
  private log(message: string): void {
    if (this.config.onLog) {
      this.config.onLog(`[WebFetchGuard] ${message}`);
    }
  }
  
  /**
   * Get current configuration
   */
  getConfig(): WebFetchGuardConfig {
    return { ...this.config };
  }
  
  /**
   * Update configuration
   */
  updateConfig(updates: Partial<WebFetchGuardConfig>): void {
    this.config = { ...this.config, ...updates };
  }
}

// ============================================================================
// Error Types
// ============================================================================

export class WebFetchBlockedError extends Error {
  public readonly url: string;
  public readonly blockReason: string;
  
  constructor(url: string, reason: string) {
    super(`Web fetch blocked: ${url} - ${reason}`);
    this.name = 'WebFetchBlockedError';
    this.url = url;
    this.blockReason = reason;
  }
}

// ============================================================================
// Hook for OpenClaw Integration
// ============================================================================

/**
 * Create a hook function for OpenClaw's tool system
 * 
 * Usage:
 * ```
 * const guard = new WebFetchGuard();
 * const hook = createWebFetchHook(guard);
 * 
 * // In before_tool_call:
 * if (call.tool === 'web_fetch') {
 *   return hook(call);
 * }
 * ```
 */
export function createWebFetchHook(guard: WebFetchGuard) {
  return async (toolCall: { tool: string; params: Record<string, unknown>; context?: { userRequest?: string } }) => {
    if (toolCall.tool !== 'web_fetch') {
      return { allow: true };
    }
    
    // Set intent from context if available
    if (toolCall.context?.userRequest && !guard['currentIntent']) {
      guard.setIntentFromRequest(toolCall.context.userRequest);
    }
    
    const url = toolCall.params.url as string;
    if (!url) {
      return { allow: true }; // Let OpenClaw handle missing URL
    }
    
    const request: WebFetchRequest = {
      url,
      method: (toolCall.params.method as string) || 'GET',
    };
    
    const result = guard.check(request);
    
    if (!result.allowed) {
      return {
        allow: false,
        reason: `Browser Guard: ${result.decision.reason}`,
      };
    }
    
    // If request was modified (e.g., cookies stripped), update params
    if (result.modified) {
      return {
        allow: true,
        transform: {
          tool: 'web_fetch',
          params: {
            ...toolCall.params,
            headers: result.request.headers,
          },
        },
      };
    }
    
    return { allow: true };
  };
}
