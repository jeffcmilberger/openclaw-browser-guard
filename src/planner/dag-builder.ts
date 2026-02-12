/**
 * DAG Builder - Generates execution DAGs from browsing intents
 * 
 * This is the core of Single-Shot Planning: we generate a complete
 * execution graph with all possible branches BEFORE seeing any web content.
 */

import type {
  BrowsingIntent,
  ExecutionDAG,
  ExecutionNode,
  ConditionalEdge,
  BrowserAction,
  ExpectedOutcome,
  Constraint,
  ExtractionTarget,
} from '../core/types.js';

// ============================================================================
// Common Branch Conditions
// ============================================================================

const COMMON_BRANCHES = {
  // Error conditions
  page_not_found: {
    type: 'content_match' as const,
    value: '404|not found|page doesn\'t exist',
    description: 'Page not found',
  },
  access_denied: {
    type: 'content_match' as const,
    value: '403|access denied|forbidden|login required',
    description: 'Access denied',
  },
  captcha: {
    type: 'element_present' as const,
    value: '[class*="captcha"], [id*="captcha"], iframe[src*="recaptcha"]',
    description: 'Captcha detected',
  },
  rate_limited: {
    type: 'content_match' as const,
    value: 'rate limit|too many requests|try again later',
    description: 'Rate limited',
  },
  
  // Common UI states
  login_required: {
    type: 'element_present' as const,
    value: 'input[type="password"], [class*="login"], [class*="signin"]',
    description: 'Login required',
  },
  cookie_consent: {
    type: 'element_present' as const,
    value: '[class*="cookie"], [class*="consent"], [class*="gdpr"]',
    description: 'Cookie consent dialog',
  },
  popup_modal: {
    type: 'element_present' as const,
    value: '[class*="modal"], [class*="popup"], [role="dialog"]',
    description: 'Popup/modal detected',
  },
};

// ============================================================================
// Plan Templates by Task Type
// ============================================================================

interface PlanTemplate {
  nodes: Partial<ExecutionNode>[];
  edges: Partial<ConditionalEdge>[];
}

const SEARCH_TEMPLATE: PlanTemplate = {
  nodes: [
    {
      id: 'navigate_search',
      action: { type: 'navigate', description: 'Navigate to search engine' },
      expectedOutcomes: [{ type: 'element_present', value: 'input[type="search"], input[name="q"]', required: true }],
      isTerminal: false,
    },
    {
      id: 'enter_query',
      action: { type: 'type', description: 'Enter search query' },
      expectedOutcomes: [],
      isTerminal: false,
    },
    {
      id: 'submit_search',
      action: { type: 'click', description: 'Submit search' },
      expectedOutcomes: [{ type: 'element_present', value: '[class*="result"], [class*="search"]', required: true }],
      isTerminal: false,
    },
    {
      id: 'extract_results',
      action: { type: 'extract', description: 'Extract search results' },
      expectedOutcomes: [],
      extractionTargets: [{ name: 'results', selector: '[class*="result"] a', type: 'text' }],
      isTerminal: true,
      terminalResult: 'success',
    },
    {
      id: 'error_captcha',
      action: { type: 'extract', description: 'Captcha detected - abort' },
      isTerminal: true,
      terminalResult: 'abort',
    },
    {
      id: 'error_no_results',
      action: { type: 'extract', description: 'No results found' },
      isTerminal: true,
      terminalResult: 'error',
    },
  ],
  edges: [
    { from: 'navigate_search', to: 'enter_query', condition: { type: 'default', description: 'Search box found' }, priority: 10 },
    { from: 'navigate_search', to: 'error_captcha', condition: COMMON_BRANCHES.captcha, priority: 1 },
    { from: 'enter_query', to: 'submit_search', condition: { type: 'default', description: 'Query entered' }, priority: 10 },
    { from: 'submit_search', to: 'extract_results', condition: { type: 'element_present', value: '[class*="result"]', description: 'Results found' }, priority: 5 },
    { from: 'submit_search', to: 'error_captcha', condition: COMMON_BRANCHES.captcha, priority: 1 },
    { from: 'submit_search', to: 'error_no_results', condition: { type: 'content_match', value: 'no results|nothing found', description: 'No results' }, priority: 3 },
  ],
};

const EXTRACT_TEMPLATE: PlanTemplate = {
  nodes: [
    {
      id: 'navigate_page',
      action: { type: 'navigate', description: 'Navigate to target page' },
      expectedOutcomes: [{ type: 'url_pattern', value: '.*', required: true }],
      isTerminal: false,
    },
    {
      id: 'dismiss_popups',
      action: { type: 'click', description: 'Dismiss cookie/popup dialogs' },
      expectedOutcomes: [],
      isTerminal: false,
    },
    {
      id: 'scroll_page',
      action: { type: 'scroll', description: 'Scroll to load content' },
      expectedOutcomes: [],
      isTerminal: false,
    },
    {
      id: 'extract_content',
      action: { type: 'extract', description: 'Extract target content' },
      expectedOutcomes: [],
      isTerminal: true,
      terminalResult: 'success',
    },
    {
      id: 'error_not_found',
      action: { type: 'extract', description: 'Page not found' },
      isTerminal: true,
      terminalResult: 'error',
    },
    {
      id: 'error_access_denied',
      action: { type: 'extract', description: 'Access denied' },
      isTerminal: true,
      terminalResult: 'error',
    },
    {
      id: 'error_login_required',
      action: { type: 'extract', description: 'Login required - abort' },
      isTerminal: true,
      terminalResult: 'abort',
    },
  ],
  edges: [
    { from: 'navigate_page', to: 'error_not_found', condition: COMMON_BRANCHES.page_not_found, priority: 1 },
    { from: 'navigate_page', to: 'error_access_denied', condition: COMMON_BRANCHES.access_denied, priority: 1 },
    { from: 'navigate_page', to: 'error_login_required', condition: COMMON_BRANCHES.login_required, priority: 2 },
    { from: 'navigate_page', to: 'dismiss_popups', condition: COMMON_BRANCHES.cookie_consent, priority: 3 },
    { from: 'navigate_page', to: 'scroll_page', condition: { type: 'default', description: 'Page loaded' }, priority: 10 },
    { from: 'dismiss_popups', to: 'scroll_page', condition: { type: 'default', description: 'Popup dismissed' }, priority: 10 },
    { from: 'scroll_page', to: 'extract_content', condition: { type: 'default', description: 'Content visible' }, priority: 10 },
  ],
};

// ============================================================================
// DAG Builder
// ============================================================================

export interface DAGBuilderOptions {
  /** Custom extraction targets */
  extractionTargets?: ExtractionTarget[];
  
  /** Additional expected outcomes to validate */
  additionalOutcomes?: ExpectedOutcome[];
  
  /** Extra constraints */
  constraints?: Constraint[];
}

/**
 * Build an execution DAG from a browsing intent
 */
export function buildDAG(intent: BrowsingIntent, options: DAGBuilderOptions = {}): ExecutionDAG {
  // Select template based on task type
  const template = selectTemplate(intent.taskType);
  
  // Instantiate template with intent-specific details
  const nodes = instantiateNodes(template.nodes, intent, options);
  const edges = instantiateEdges(template.edges);
  
  // Add domain constraints to all nodes
  const domainConstraint: Constraint = {
    type: 'domain',
    rule: intent.allowedDomains.join('|'),
    errorMessage: `Navigation outside allowed domains: ${intent.allowedDomains.join(', ')}`,
  };
  
  for (const node of nodes) {
    node.constraints.push(domainConstraint);
  }
  
  // Find entry point (first non-error node)
  const entryPoint = nodes.find(n => !n.id.startsWith('error_'))?.id ?? nodes[0].id;
  
  return {
    id: `dag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    intent,
    nodes,
    edges,
    entryPoint,
    createdAt: Date.now(),
  };
}

/**
 * Select the appropriate template for a task type
 */
function selectTemplate(taskType: BrowsingIntent['taskType']): PlanTemplate {
  switch (taskType) {
    case 'search':
      return SEARCH_TEMPLATE;
    case 'extract':
    case 'monitor':
      return EXTRACT_TEMPLATE;
    // TODO: Add more templates
    default:
      return EXTRACT_TEMPLATE;
  }
}

/**
 * Instantiate template nodes with intent-specific details
 */
function instantiateNodes(
  templates: Partial<ExecutionNode>[],
  intent: BrowsingIntent,
  options: DAGBuilderOptions
): ExecutionNode[] {
  return templates.map((template, index) => {
    const node: ExecutionNode = {
      id: template.id ?? `node_${index}`,
      action: template.action ?? { type: 'extract', description: 'Unknown action' },
      expectedOutcomes: template.expectedOutcomes ?? [],
      extractionTargets: template.extractionTargets,
      constraints: options.constraints ?? [],
      isTerminal: template.isTerminal ?? false,
      terminalResult: template.terminalResult,
    };
    
    // Add custom extraction targets
    if (options.extractionTargets && node.action.type === 'extract') {
      node.extractionTargets = [
        ...(node.extractionTargets ?? []),
        ...options.extractionTargets,
      ];
    }
    
    // Add additional outcomes
    if (options.additionalOutcomes) {
      node.expectedOutcomes = [
        ...node.expectedOutcomes,
        ...options.additionalOutcomes,
      ];
    }
    
    // Set navigate targets
    if (node.action.type === 'navigate' && !node.action.target) {
      // Use first allowed domain as default target
      node.action.target = `https://${intent.allowedDomains[0]}`;
    }
    
    return node;
  });
}

/**
 * Instantiate template edges
 */
function instantiateEdges(templates: Partial<ConditionalEdge>[]): ConditionalEdge[] {
  return templates.map((template, index) => ({
    from: template.from ?? '',
    to: template.to ?? '',
    condition: template.condition ?? { type: 'default', description: 'Default' },
    priority: template.priority ?? index,
  }));
}

/**
 * Validate a DAG for structural correctness
 */
export function validateDAG(dag: ExecutionDAG): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  const nodeIds = new Set(dag.nodes.map(n => n.id));
  
  // Check entry point exists
  if (!nodeIds.has(dag.entryPoint)) {
    issues.push(`Entry point '${dag.entryPoint}' does not exist in nodes`);
  }
  
  // Check all edge references are valid
  for (const edge of dag.edges) {
    if (!nodeIds.has(edge.from)) {
      issues.push(`Edge references non-existent source node: ${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      issues.push(`Edge references non-existent target node: ${edge.to}`);
    }
  }
  
  // Check all non-terminal nodes have outgoing edges
  for (const node of dag.nodes) {
    if (!node.isTerminal) {
      const hasOutgoing = dag.edges.some(e => e.from === node.id);
      if (!hasOutgoing) {
        issues.push(`Non-terminal node '${node.id}' has no outgoing edges`);
      }
    }
  }
  
  // Check there's at least one terminal node
  const terminals = dag.nodes.filter(n => n.isTerminal);
  if (terminals.length === 0) {
    issues.push('DAG has no terminal nodes');
  }
  
  // Check for unreachable nodes (simple check)
  const reachable = new Set<string>([dag.entryPoint]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of dag.edges) {
      if (reachable.has(edge.from) && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        changed = true;
      }
    }
  }
  
  for (const node of dag.nodes) {
    if (!reachable.has(node.id)) {
      issues.push(`Node '${node.id}' is unreachable from entry point`);
    }
  }
  
  return { valid: issues.length === 0, issues };
}

/**
 * Serialize DAG to JSON for inspection
 */
export function serializeDAG(dag: ExecutionDAG): string {
  return JSON.stringify(dag, null, 2);
}

/**
 * Generate a human-readable plan description
 */
export function describePlan(dag: ExecutionDAG): string {
  const lines: string[] = [
    `# Execution Plan: ${dag.intent.goal}`,
    '',
    `**Task Type:** ${dag.intent.taskType}`,
    `**Allowed Domains:** ${dag.intent.allowedDomains.join(', ')}`,
    `**Max Depth:** ${dag.intent.maxDepth}`,
    `**Timeout:** ${dag.intent.timeout}ms`,
    '',
    '## Execution Steps',
    '',
  ];
  
  // BFS to show steps in order
  const visited = new Set<string>();
  const queue = [dag.entryPoint];
  let stepNum = 1;
  
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    
    const node = dag.nodes.find(n => n.id === nodeId);
    if (!node) continue;
    
    lines.push(`${stepNum}. **${node.action.description}** (${node.action.type})`);
    
    if (node.isTerminal) {
      lines.push(`   → *Terminal: ${node.terminalResult}*`);
    } else {
      const outEdges = dag.edges.filter(e => e.from === nodeId);
      for (const edge of outEdges) {
        lines.push(`   - If ${edge.condition.description} → ${edge.to}`);
        if (!visited.has(edge.to)) {
          queue.push(edge.to);
        }
      }
    }
    
    lines.push('');
    stepNum++;
  }
  
  return lines.join('\n');
}
