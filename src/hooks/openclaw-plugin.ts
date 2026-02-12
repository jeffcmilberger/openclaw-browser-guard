/**
 * OpenClaw Plugin Integration
 * 
 * Hooks into OpenClaw's tool system to intercept and guard
 * web_fetch and browser tool calls.
 */

import { parseIntent, validateIntent } from '../core/task-parser.js';
import { PolicyEngine } from '../policy/engine.js';
import { buildDAG, validateDAG, describePlan } from '../planner/dag-builder.js';
import { SecureExecutor, type BrowserAdapter } from '../executor/runtime.js';
import type {
  BrowsingIntent,
  ExecutionDAG,
  ExecutionResult,
  ToolCall,
  ToolCallDecision,
  Observation,
} from '../core/types.js';

// ============================================================================
// Plugin Configuration
// ============================================================================

export interface BrowserGuardConfig {
  /** Enable/disable the guard */
  enabled: boolean;
  
  /** Mode: 'warn' logs issues but allows, 'block' prevents execution */
  mode: 'warn' | 'block';
  
  /** Whether to show execution plans to user before running */
  showPlans: boolean;
  
  /** Domains that bypass the guard entirely */
  trustedDomains: string[];
  
  /** Log file for debugging */
  logFile?: string;
  
  /** Strict mode - abort on any unexpected state */
  strictMode: boolean;
}

const DEFAULT_CONFIG: BrowserGuardConfig = {
  enabled: true,
  mode: 'block',
  showPlans: false,
  trustedDomains: [],
  strictMode: true,
};

// ============================================================================
// Guard State
// ============================================================================

interface GuardState {
  /** Pending plans awaiting user confirmation */
  pendingPlans: Map<string, { dag: ExecutionDAG; resolve: (approved: boolean) => void }>;
  
  /** Execution results cache */
  results: Map<string, ExecutionResult>;
  
  /** Debug log */
  log: string[];
}

const state: GuardState = {
  pendingPlans: new Map(),
  results: new Map(),
  log: [],
};

// ============================================================================
// Main Plugin
// ============================================================================

export class BrowserGuardPlugin {
  private config: BrowserGuardConfig;
  private adapter?: BrowserAdapter;
  
  constructor(config: Partial<BrowserGuardConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /**
   * Set the browser adapter (for actual execution)
   */
  setAdapter(adapter: BrowserAdapter): void {
    this.adapter = adapter;
  }
  
  /**
   * Hook: before_tool_call
   * Intercepts web_fetch and browser tool calls
   */
  async beforeToolCall(call: ToolCall): Promise<ToolCallDecision> {
    if (!this.config.enabled) {
      return { allow: true };
    }
    
    // Only intercept web_fetch and browser tools
    if (call.tool !== 'web_fetch' && call.tool !== 'browser') {
      return { allow: true };
    }
    
    this.log(`Intercepted ${call.tool} call`);
    
    try {
      // Check if URL is in trusted domains
      const url = this.extractUrl(call);
      if (url && this.isTrustedDomain(url)) {
        this.log(`URL ${url} is in trusted domains, bypassing guard`);
        return { allow: true };
      }
      
      // Parse the user's intent from conversation context
      const intent = this.parseIntentFromContext(call);
      this.log(`Parsed intent: ${JSON.stringify(intent)}`);
      
      // Validate intent
      const intentValidation = validateIntent(intent);
      if (!intentValidation.valid) {
        this.log(`Intent validation failed: ${intentValidation.issues.join(', ')}`);
        
        if (this.config.mode === 'block') {
          return {
            allow: false,
            reason: `Browser Guard: Intent validation failed - ${intentValidation.issues.join(', ')}`,
          };
        }
      }
      
      // Check policy
      const policy = new PolicyEngine(intent);
      const policyCheck = policy.allowsIntent(intent);
      if (!policyCheck.allowed) {
        this.log(`Policy check failed: ${policyCheck.reason}`);
        
        if (this.config.mode === 'block') {
          return {
            allow: false,
            reason: `Browser Guard: ${policyCheck.reason}`,
          };
        }
      }
      
      // Build execution DAG
      const dag = buildDAG(intent);
      const dagValidation = validateDAG(dag);
      if (!dagValidation.valid) {
        this.log(`DAG validation failed: ${dagValidation.issues.join(', ')}`);
        
        if (this.config.mode === 'block') {
          return {
            allow: false,
            reason: `Browser Guard: Plan validation failed - ${dagValidation.issues.join(', ')}`,
          };
        }
      }
      
      this.log(`Built execution DAG with ${dag.nodes.length} nodes`);
      
      // If show plans is enabled, we need user confirmation
      if (this.config.showPlans) {
        const planDescription = describePlan(dag);
        this.log(`Plan requires confirmation:\n${planDescription}`);
        
        // Store pending plan and transform to confirmation request
        const planId = `plan_${Date.now()}`;
        
        return {
          allow: true,
          transform: {
            tool: 'browser_guard_confirm',
            params: {
              planId,
              plan: planDescription,
              originalTool: call.tool,
              originalParams: call.params,
            },
          },
        };
      }
      
      // Execute with guard
      if (this.adapter) {
        const executor = new SecureExecutor(this.adapter, policy, {
          strictMode: this.config.strictMode,
          onStep: (node, obs) => this.log(`Step: ${node.id} → ${obs.url}`),
          onBranch: (from, to, cond) => this.log(`Branch: ${from} → ${to} (${cond})`),
        });
        
        const result = await executor.execute(dag);
        this.log(`Execution result: ${result.status}`);
        
        if (result.status !== 'complete') {
          if (this.config.mode === 'block') {
            return {
              allow: false,
              reason: `Browser Guard: Execution ${result.status} - ${result.reason}`,
            };
          }
        }
        
        // Store result and return extracted data
        state.results.set(dag.id, result);
        
        return {
          allow: true,
          transform: {
            tool: 'browser_guard_result',
            params: {
              dagId: dag.id,
              status: result.status,
              data: result.data,
              reason: result.reason,
            },
          },
        };
      }
      
      // No adapter - allow original call with warning
      this.log('No browser adapter configured, allowing original call');
      return { allow: true };
      
    } catch (error) {
      this.log(`Error in beforeToolCall: ${error}`);
      
      if (this.config.mode === 'block') {
        return {
          allow: false,
          reason: `Browser Guard: Internal error - ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      
      return { allow: true };
    }
  }
  
  /**
   * Parse intent from tool call context
   */
  private parseIntentFromContext(call: ToolCall): BrowsingIntent {
    // Extract URL from params
    const url = this.extractUrl(call);
    
    // Use the user's request as the basis for intent parsing
    const userRequest = call.context.userRequest || '';
    
    // Parse intent with URL as extra domain hint
    const extraDomains = url ? [this.extractDomain(url)] : [];
    
    return parseIntent(userRequest, { extraDomains });
  }
  
  /**
   * Extract URL from tool call params
   */
  private extractUrl(call: ToolCall): string | undefined {
    if (call.tool === 'web_fetch') {
      return call.params.url as string | undefined;
    }
    
    if (call.tool === 'browser') {
      // Browser tool might have URL in various places
      return (call.params.url ?? call.params.targetUrl) as string | undefined;
    }
    
    return undefined;
  }
  
  /**
   * Extract domain from URL
   */
  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }
  
  /**
   * Check if URL is in trusted domains
   */
  private isTrustedDomain(url: string): boolean {
    const domain = this.extractDomain(url);
    return this.config.trustedDomains.some(d => 
      domain === d || domain.endsWith(`.${d}`)
    );
  }
  
  /**
   * Log a message
   */
  private log(message: string): void {
    const entry = `[${new Date().toISOString()}] ${message}`;
    state.log.push(entry);
    
    if (this.config.logFile) {
      // In production, would append to file
      console.log(`[BrowserGuard] ${message}`);
    }
  }
  
  /**
   * Get debug log
   */
  getLog(): string[] {
    return [...state.log];
  }
  
  /**
   * Clear state
   */
  clearState(): void {
    state.pendingPlans.clear();
    state.results.clear();
    state.log.length = 0;
  }
}

// ============================================================================
// OpenClaw Plugin Export
// ============================================================================

/**
 * Create plugin instance for OpenClaw
 */
export function createPlugin(config?: Partial<BrowserGuardConfig>): {
  name: string;
  hooks: {
    before_tool_call: (call: ToolCall) => Promise<ToolCallDecision>;
  };
  commands: Record<string, (args: string[]) => string>;
} {
  const plugin = new BrowserGuardPlugin(config);
  
  return {
    name: 'browser-guard',
    
    hooks: {
      before_tool_call: (call) => plugin.beforeToolCall(call),
    },
    
    commands: {
      // /browser-guard or /bg command
      'browser-guard': (args) => {
        const [subcommand] = args;
        
        switch (subcommand) {
          case 'status':
            return `Browser Guard: ${plugin['config'].enabled ? 'enabled' : 'disabled'} (${plugin['config'].mode} mode)`;
            
          case 'log':
            return plugin.getLog().slice(-20).join('\n') || 'No log entries';
            
          case 'clear':
            plugin.clearState();
            return 'Browser Guard state cleared';
            
          default:
            return `Browser Guard commands:
  /browser-guard status - Show current status
  /browser-guard log    - Show recent log entries
  /browser-guard clear  - Clear state and log`;
        }
      },
      
      'bg': (args) => {
        // Alias for browser-guard
        return createPlugin(config).commands['browser-guard'](args);
      },
    },
  };
}

// Default export
export default createPlugin;
