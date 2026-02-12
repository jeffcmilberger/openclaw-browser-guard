/**
 * Core types for OpenClaw Browser Guard
 */

// ============================================================================
// Browsing Intent
// ============================================================================

export type ActionType = 
  | 'navigate'
  | 'click'
  | 'scroll'
  | 'type'
  | 'extract'
  | 'screenshot'
  | 'wait';

export interface BrowsingIntent {
  /** What the user wants to achieve */
  goal: string;
  
  /** High-level task type */
  taskType: 'search' | 'extract' | 'monitor' | 'interact' | 'purchase' | 'login';
  
  /** Domains we're allowed to visit */
  allowedDomains: string[];
  
  /** Actions permitted for this task */
  allowedActions: ActionType[];
  
  /** Data that must never leave the system */
  sensitiveData: string[];
  
  /** Maximum navigation depth from start URL */
  maxDepth: number;
  
  /** Maximum execution time in ms */
  timeout: number;
  
  /** Original user request (for logging) */
  originalRequest: string;
}

// ============================================================================
// Execution DAG
// ============================================================================

export interface BrowserAction {
  type: ActionType;
  target?: string;        // CSS selector, URL, or text
  value?: string;         // For type actions
  description: string;    // Human-readable description
}

export interface Constraint {
  type: 'domain' | 'action' | 'content' | 'timing';
  rule: string;
  errorMessage: string;
}

export interface ExecutionNode {
  id: string;
  action: BrowserAction;
  
  /** What we expect to observe after this action */
  expectedOutcomes: ExpectedOutcome[];
  
  /** Data to extract at this node */
  extractionTargets?: ExtractionTarget[];
  
  /** Security constraints for this node */
  constraints: Constraint[];
  
  /** Whether this is a terminal node */
  isTerminal: boolean;
  
  /** Result type if terminal */
  terminalResult?: 'success' | 'error' | 'abort';
}

export interface ExpectedOutcome {
  type: 'url_pattern' | 'element_present' | 'element_absent' | 'content_match';
  value: string;
  required: boolean;
}

export interface ExtractionTarget {
  name: string;
  selector: string;
  type: 'text' | 'attribute' | 'html';
  attribute?: string;
}

export interface BranchCondition {
  type: 'element_present' | 'element_absent' | 'url_match' | 'content_match' | 'default';
  value?: string;
  description: string;
}

export interface ConditionalEdge {
  from: string;
  to: string;
  condition: BranchCondition;
  priority: number;  // Lower = checked first
}

export interface ExecutionDAG {
  id: string;
  intent: BrowsingIntent;
  nodes: ExecutionNode[];
  edges: ConditionalEdge[];
  entryPoint: string;
  createdAt: number;
}

// ============================================================================
// Policy
// ============================================================================

export type PolicySource = 'static' | 'site' | 'task' | 'user';

export interface PolicyRule {
  id: string;
  source: PolicySource;
  
  /** What this rule applies to */
  scope: {
    domains?: string[];
    actions?: ActionType[];
    taskTypes?: BrowsingIntent['taskType'][];
  };
  
  /** The rule itself */
  effect: 'allow' | 'deny' | 'confirm';
  
  /** Human-readable description */
  description: string;
  
  /** Priority (lower = higher priority) */
  priority: number;
}

export interface Policy {
  /** Check if an action is allowed */
  allows(action: BrowserAction, context: ExecutionContext): PolicyDecision;
  
  /** Check if entire intent is allowed */
  allowsIntent(intent: BrowsingIntent): PolicyDecision;
  
  /** Get all rules (for inspection) */
  getRules(): PolicyRule[];
}

export interface PolicyDecision {
  allowed: boolean;
  effect: 'allow' | 'deny' | 'confirm';
  matchedRule?: PolicyRule;
  reason?: string;
}

// ============================================================================
// Execution
// ============================================================================

export interface ExecutionContext {
  currentUrl: string;
  currentDomain: string;
  visitedUrls: string[];
  depth: number;
  startTime: number;
  extractedData: Record<string, unknown>;
}

export interface Observation {
  url: string;
  title: string;
  domSnapshot?: string;
  visibleText?: string;
  elements?: ObservedElement[];
  timestamp: number;
}

export interface ObservedElement {
  selector: string;
  tagName: string;
  text?: string;
  attributes?: Record<string, string>;
  visible: boolean;
}

export type ExecutionStatus = 
  | 'running'
  | 'complete'
  | 'aborted'
  | 'blocked'
  | 'timeout'
  | 'error';

export interface ExecutionResult {
  status: ExecutionStatus;
  data?: Record<string, unknown>;
  reason?: string;
  trace: ExecutionTraceEntry[];
  duration: number;
}

export interface ExecutionTraceEntry {
  nodeId: string;
  action: BrowserAction;
  observation: Observation;
  decision: 'continue' | 'branch' | 'abort';
  branchTaken?: string;
  timestamp: number;
}

// ============================================================================
// Hooks (OpenClaw Integration)
// ============================================================================

export interface ToolCall {
  tool: string;
  params: Record<string, unknown>;
  context: {
    conversationHistory: string[];
    userRequest: string;
  };
}

export interface ToolCallDecision {
  allow: boolean;
  reason?: string;
  transform?: {
    tool: string;
    params: Record<string, unknown>;
  };
}

export interface BrowserGuardHook {
  name: string;
  beforeToolCall(call: ToolCall): Promise<ToolCallDecision>;
  afterToolResult?(result: unknown): Promise<unknown>;
}
