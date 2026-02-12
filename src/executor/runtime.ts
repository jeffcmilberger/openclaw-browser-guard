/**
 * Secure Executor Runtime
 * 
 * Executes an ExecutionDAG while enforcing security constraints.
 * Observations only feed back at predefined branch points.
 */

import type {
  ExecutionDAG,
  ExecutionNode,
  ConditionalEdge,
  ExecutionContext,
  ExecutionResult,
  ExecutionTraceEntry,
  Observation,
  Policy,
  BrowserAction,
  ExpectedOutcome,
} from '../core/types.js';

// ============================================================================
// Browser Adapter Interface
// ============================================================================

/**
 * Adapter interface for browser/fetch operations
 * Implementations will wrap OpenClaw's browser or web_fetch tools
 */
export interface BrowserAdapter {
  /** Navigate to a URL */
  navigate(url: string): Promise<Observation>;
  
  /** Click an element */
  click(selector: string): Promise<Observation>;
  
  /** Type text into an element */
  type(selector: string, text: string): Promise<Observation>;
  
  /** Scroll the page */
  scroll(direction: 'up' | 'down', amount?: number): Promise<Observation>;
  
  /** Extract content from the page */
  extract(selectors: Record<string, string>): Promise<{ observation: Observation; data: Record<string, unknown> }>;
  
  /** Take a screenshot */
  screenshot(): Promise<{ observation: Observation; image: string }>;
  
  /** Wait for a condition or time */
  wait(ms: number): Promise<Observation>;
  
  /** Get current page state */
  getState(): Promise<Observation>;
}

// ============================================================================
// Executor Configuration
// ============================================================================

export interface ExecutorConfig {
  /** Maximum execution time (overrides DAG intent) */
  maxTimeout?: number;
  
  /** Whether to collect detailed traces */
  traceEnabled?: boolean;
  
  /** Callback for each step (for progress reporting) */
  onStep?: (node: ExecutionNode, observation: Observation) => void;
  
  /** Callback for branch decisions */
  onBranch?: (from: string, to: string, condition: string) => void;
  
  /** Strict mode - abort on any unexpected state */
  strictMode?: boolean;
}

// ============================================================================
// Secure Executor
// ============================================================================

export class SecureExecutor {
  private adapter: BrowserAdapter;
  private policy: Policy;
  private config: ExecutorConfig;
  
  constructor(adapter: BrowserAdapter, policy: Policy, config: ExecutorConfig = {}) {
    this.adapter = adapter;
    this.policy = policy;
    this.config = {
      traceEnabled: true,
      strictMode: true,
      ...config,
    };
  }
  
  /**
   * Execute a DAG securely
   */
  async execute(dag: ExecutionDAG): Promise<ExecutionResult> {
    const startTime = Date.now();
    const timeout = this.config.maxTimeout ?? dag.intent.timeout;
    const trace: ExecutionTraceEntry[] = [];
    const extractedData: Record<string, unknown> = {};
    
    const context: ExecutionContext = {
      currentUrl: '',
      currentDomain: '',
      visitedUrls: [],
      depth: 0,
      startTime,
      extractedData,
    };
    
    let currentNodeId = dag.entryPoint;
    
    try {
      while (true) {
        // Check timeout
        if (Date.now() - startTime > timeout) {
          return {
            status: 'timeout',
            reason: `Execution exceeded timeout of ${timeout}ms`,
            trace,
            duration: Date.now() - startTime,
          };
        }
        
        // Find current node
        const node = dag.nodes.find(n => n.id === currentNodeId);
        if (!node) {
          return {
            status: 'error',
            reason: `Node '${currentNodeId}' not found in DAG`,
            trace,
            duration: Date.now() - startTime,
          };
        }
        
        // Check policy before action
        const policyCheck = this.policy.allows(node.action, context);
        if (!policyCheck.allowed) {
          return {
            status: 'blocked',
            reason: policyCheck.reason ?? 'Policy violation',
            trace,
            duration: Date.now() - startTime,
          };
        }
        
        // Execute the action
        const { observation, data } = await this.executeAction(node, context);
        
        // Update context
        context.currentUrl = observation.url;
        context.currentDomain = this.extractDomain(observation.url);
        context.visitedUrls.push(observation.url);
        context.depth++;
        
        // Merge extracted data
        if (data) {
          Object.assign(extractedData, data);
        }
        
        // Report step
        this.config.onStep?.(node, observation);
        
        // Add to trace
        if (this.config.traceEnabled) {
          trace.push({
            nodeId: node.id,
            action: node.action,
            observation,
            decision: node.isTerminal ? 'abort' : 'continue',
            timestamp: Date.now(),
          });
        }
        
        // Check if terminal
        if (node.isTerminal) {
          return {
            status: node.terminalResult === 'success' ? 'complete' : 
                   node.terminalResult === 'abort' ? 'aborted' : 'error',
            data: extractedData,
            reason: node.terminalResult !== 'success' ? node.action.description : undefined,
            trace,
            duration: Date.now() - startTime,
          };
        }
        
        // Validate observation against expected outcomes
        const outcomeCheck = this.validateOutcomes(observation, node.expectedOutcomes);
        if (!outcomeCheck.valid && this.config.strictMode) {
          return {
            status: 'aborted',
            reason: `Unexpected state: ${outcomeCheck.reason}`,
            trace,
            duration: Date.now() - startTime,
          };
        }
        
        // Select next branch
        const nextNodeId = this.selectBranch(dag.edges, currentNodeId, observation);
        if (!nextNodeId) {
          return {
            status: 'error',
            reason: `No valid branch from node '${currentNodeId}'`,
            trace,
            duration: Date.now() - startTime,
          };
        }
        
        // Update trace with branch decision
        if (this.config.traceEnabled && trace.length > 0) {
          trace[trace.length - 1].decision = 'branch';
          trace[trace.length - 1].branchTaken = nextNodeId;
        }
        
        // Report branch
        const takenEdge = dag.edges.find(e => e.from === currentNodeId && e.to === nextNodeId);
        this.config.onBranch?.(currentNodeId, nextNodeId, takenEdge?.condition.description ?? 'unknown');
        
        // Branch steering detection
        const steeringCheck = this.detectBranchSteering(observation, takenEdge!, context);
        if (!steeringCheck.safe) {
          return {
            status: 'aborted',
            reason: `Potential branch steering detected: ${steeringCheck.reason}`,
            trace,
            duration: Date.now() - startTime,
          };
        }
        
        currentNodeId = nextNodeId;
      }
    } catch (error) {
      return {
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
        trace,
        duration: Date.now() - startTime,
      };
    }
  }
  
  /**
   * Execute a single action
   */
  private async executeAction(
    node: ExecutionNode,
    context: ExecutionContext
  ): Promise<{ observation: Observation; data?: Record<string, unknown> }> {
    const action = node.action;
    
    switch (action.type) {
      case 'navigate':
        return { observation: await this.adapter.navigate(action.target!) };
        
      case 'click':
        return { observation: await this.adapter.click(action.target!) };
        
      case 'type':
        return { observation: await this.adapter.type(action.target!, action.value!) };
        
      case 'scroll':
        return { observation: await this.adapter.scroll('down') };
        
      case 'extract': {
        if (!node.extractionTargets || node.extractionTargets.length === 0) {
          return { observation: await this.adapter.getState() };
        }
        
        const selectors: Record<string, string> = {};
        for (const target of node.extractionTargets) {
          selectors[target.name] = target.selector;
        }
        
        return await this.adapter.extract(selectors);
      }
        
      case 'screenshot': {
        const result = await this.adapter.screenshot();
        return { observation: result.observation, data: { screenshot: result.image } };
      }
        
      case 'wait':
        return { observation: await this.adapter.wait(1000) };
        
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }
  
  /**
   * Validate observation against expected outcomes
   */
  private validateOutcomes(
    observation: Observation,
    outcomes: ExpectedOutcome[]
  ): { valid: boolean; reason?: string } {
    for (const outcome of outcomes) {
      if (!outcome.required) continue;
      
      switch (outcome.type) {
        case 'url_pattern': {
          const pattern = new RegExp(outcome.value);
          if (!pattern.test(observation.url)) {
            return { valid: false, reason: `URL doesn't match pattern: ${outcome.value}` };
          }
          break;
        }
        
        case 'element_present': {
          const hasElement = observation.elements?.some(e => 
            this.matchesSelector(e, outcome.value)
          );
          if (!hasElement) {
            return { valid: false, reason: `Required element not found: ${outcome.value}` };
          }
          break;
        }
        
        case 'element_absent': {
          const hasElement = observation.elements?.some(e => 
            this.matchesSelector(e, outcome.value)
          );
          if (hasElement) {
            return { valid: false, reason: `Forbidden element found: ${outcome.value}` };
          }
          break;
        }
        
        case 'content_match': {
          const pattern = new RegExp(outcome.value, 'i');
          if (!pattern.test(observation.visibleText ?? '')) {
            return { valid: false, reason: `Content doesn't match: ${outcome.value}` };
          }
          break;
        }
      }
    }
    
    return { valid: true };
  }
  
  /**
   * Select the next branch based on observation
   */
  private selectBranch(
    edges: ConditionalEdge[],
    currentNodeId: string,
    observation: Observation
  ): string | null {
    // Get all outgoing edges, sorted by priority
    const outgoing = edges
      .filter(e => e.from === currentNodeId)
      .sort((a, b) => a.priority - b.priority);
    
    for (const edge of outgoing) {
      if (this.evaluateCondition(edge.condition, observation)) {
        return edge.to;
      }
    }
    
    // No condition matched
    return null;
  }
  
  /**
   * Evaluate a branch condition against an observation
   */
  private evaluateCondition(
    condition: ConditionalEdge['condition'],
    observation: Observation
  ): boolean {
    switch (condition.type) {
      case 'default':
        return true;
        
      case 'element_present':
        return observation.elements?.some(e => 
          this.matchesSelector(e, condition.value!)
        ) ?? false;
        
      case 'element_absent':
        return !observation.elements?.some(e => 
          this.matchesSelector(e, condition.value!)
        );
        
      case 'url_match':
        return new RegExp(condition.value!).test(observation.url);
        
      case 'content_match':
        return new RegExp(condition.value!, 'i').test(observation.visibleText ?? '');
        
      default:
        return false;
    }
  }
  
  /**
   * Simple selector matching (would need CSS selector parsing in production)
   */
  private matchesSelector(element: Observation['elements'][0], selector: string): boolean {
    // Very simplified - just check tag name and class/id patterns
    const selectorLower = selector.toLowerCase();
    
    if (selectorLower.startsWith('.')) {
      const className = selectorLower.slice(1);
      return element.attributes?.class?.toLowerCase().includes(className) ?? false;
    }
    
    if (selectorLower.startsWith('#')) {
      const id = selectorLower.slice(1);
      return element.attributes?.id?.toLowerCase() === id;
    }
    
    if (selectorLower.includes('[')) {
      // Attribute selector - simplified
      const match = selectorLower.match(/\[([^=\]]+)(?:([*^$]?)=["']?([^"'\]]+)["']?)?\]/);
      if (match) {
        const [, attr, op, value] = match;
        const attrValue = element.attributes?.[attr]?.toLowerCase() ?? '';
        
        if (!value) return !!attrValue;
        if (!op || op === '') return attrValue === value;
        if (op === '*') return attrValue.includes(value);
        if (op === '^') return attrValue.startsWith(value);
        if (op === '$') return attrValue.endsWith(value);
      }
    }
    
    // Tag name match
    return element.tagName.toLowerCase() === selectorLower;
  }
  
  /**
   * Detect potential branch steering attacks
   */
  private detectBranchSteering(
    observation: Observation,
    edge: ConditionalEdge,
    context: ExecutionContext
  ): { safe: boolean; reason?: string } {
    // Check for unexpected redirects
    if (context.visitedUrls.length > 0) {
      const lastUrl = context.visitedUrls[context.visitedUrls.length - 1];
      const lastDomain = this.extractDomain(lastUrl);
      const currentDomain = this.extractDomain(observation.url);
      
      if (lastDomain !== currentDomain) {
        // Domain changed - verify it's expected
        const allowedDomains = context.extractedData['_allowedDomains'] as string[] ?? [];
        if (allowedDomains.length > 0 && !allowedDomains.includes(currentDomain)) {
          return {
            safe: false,
            reason: `Unexpected redirect from ${lastDomain} to ${currentDomain}`,
          };
        }
      }
    }
    
    // Check for suspiciously similar-looking pages (visual steering)
    // This would use perceptual hashing in a full implementation
    
    // Check for form action mismatches
    // (form says one thing, but action goes somewhere else)
    
    return { safe: true };
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
}

// ============================================================================
// Mock Adapter (for testing)
// ============================================================================

export class MockBrowserAdapter implements BrowserAdapter {
  private currentUrl = 'about:blank';
  private pages: Map<string, { title: string; text: string; elements: Observation['elements'] }> = new Map();
  
  addPage(url: string, page: { title: string; text: string; elements?: Observation['elements'] }) {
    this.pages.set(url, { ...page, elements: page.elements ?? [] });
  }
  
  private makeObservation(): Observation {
    const page = this.pages.get(this.currentUrl);
    return {
      url: this.currentUrl,
      title: page?.title ?? 'Unknown',
      visibleText: page?.text ?? '',
      elements: page?.elements ?? [],
      timestamp: Date.now(),
    };
  }
  
  async navigate(url: string): Promise<Observation> {
    this.currentUrl = url;
    return this.makeObservation();
  }
  
  async click(selector: string): Promise<Observation> {
    return this.makeObservation();
  }
  
  async type(selector: string, text: string): Promise<Observation> {
    return this.makeObservation();
  }
  
  async scroll(direction: 'up' | 'down', amount?: number): Promise<Observation> {
    return this.makeObservation();
  }
  
  async extract(selectors: Record<string, string>): Promise<{ observation: Observation; data: Record<string, unknown> }> {
    const page = this.pages.get(this.currentUrl);
    const data: Record<string, unknown> = {};
    
    // Mock extraction
    for (const [name, selector] of Object.entries(selectors)) {
      const element = page?.elements?.find(e => this.elementMatchesSelector(e, selector));
      data[name] = element?.text ?? null;
    }
    
    return { observation: this.makeObservation(), data };
  }
  
  async screenshot(): Promise<{ observation: Observation; image: string }> {
    return { observation: this.makeObservation(), image: 'data:image/png;base64,mock' };
  }
  
  async wait(ms: number): Promise<Observation> {
    await new Promise(resolve => setTimeout(resolve, ms));
    return this.makeObservation();
  }
  
  async getState(): Promise<Observation> {
    return this.makeObservation();
  }
  
  private elementMatchesSelector(element: Observation['elements'][0], selector: string): boolean {
    // Simplified matching
    return element.selector === selector || 
           element.tagName.toLowerCase() === selector.toLowerCase();
  }
}
