/**
 * LLM-based Planner for Browser Guard
 * 
 * Generates execution DAGs using an LLM with structured output.
 * Maintains single-shot security: plan is generated BEFORE seeing any web content.
 * 
 * Key features:
 * - Provider-agnostic interface
 * - Schema-enforced structured output
 * - Validation of generated plans
 * - Fallback to templates on failure
 */

import type {
  BrowsingIntent,
  ExecutionDAG,
  ExecutionNode,
  ConditionalEdge,
  Constraint,
} from '../core/types.js';
import { buildDAG, validateDAG } from './dag-builder.js';

// ============================================================================
// JSON Schema for DAG Generation
// ============================================================================

/**
 * JSON Schema for structured output - defines the shape of generated DAGs
 */
export const DAG_SCHEMA = {
  type: 'object',
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique identifier for this node' },
          action: {
            type: 'object',
            properties: {
              type: { 
                type: 'string', 
                enum: ['navigate', 'click', 'scroll', 'type', 'extract', 'screenshot', 'wait'],
                description: 'The type of browser action'
              },
              target: { type: 'string', description: 'CSS selector, URL, or text target' },
              value: { type: 'string', description: 'Value for type actions' },
              description: { type: 'string', description: 'Human-readable description' },
            },
            required: ['type', 'description'],
          },
          expectedOutcomes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['url_pattern', 'element_present', 'element_absent', 'content_match'] },
                value: { type: 'string' },
                required: { type: 'boolean' },
              },
            },
            description: 'What we expect to observe after this action',
          },
          extractionTargets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                selector: { type: 'string' },
                type: { type: 'string', enum: ['text', 'attribute', 'html'] },
                attribute: { type: 'string' },
              },
            },
            description: 'Data to extract at this node',
          },
          isTerminal: { type: 'boolean', description: 'Whether this is a terminal node' },
          terminalResult: { 
            type: 'string', 
            enum: ['success', 'error', 'abort'],
            description: 'Result type if terminal'
          },
        },
        required: ['id', 'action'],
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source node id' },
          to: { type: 'string', description: 'Target node id' },
          condition: {
            type: 'object',
            properties: {
              type: { 
                type: 'string', 
                enum: ['element_present', 'element_absent', 'url_match', 'content_match', 'default'],
                description: 'Condition type for taking this edge'
              },
              value: { type: 'string', description: 'Selector, regex, or pattern to match' },
              description: { type: 'string', description: 'Human-readable description' },
            },
            required: ['type', 'description'],
          },
          priority: { type: 'number', description: 'Lower priority = checked first' },
        },
        required: ['from', 'to', 'condition'],
      },
    },
    entryPoint: { type: 'string', description: 'ID of the starting node' },
  },
  required: ['nodes', 'edges', 'entryPoint'],
} as const;

// ============================================================================
// System Prompt
// ============================================================================

/**
 * System prompt that explains single-shot planning to the LLM
 */
export const PLANNER_SYSTEM_PROMPT = `You are a security-focused browser automation planner. Your task is to generate complete execution plans for web browsing tasks.

## Critical Security Principle: Single-Shot Planning

You MUST generate the ENTIRE execution plan upfront, BEFORE any web content is observed. This is critical for security - the plan cannot be influenced by potentially malicious web content.

## Plan Structure

Generate a Directed Acyclic Graph (DAG) with:
- **Nodes**: Individual browser actions (navigate, click, type, scroll, extract, etc.)
- **Edges**: Conditional transitions between nodes based on observed state
- **Terminal nodes**: End states (success, error, abort)

## Branch Enumeration

You MUST enumerate ALL possible execution paths upfront:

1. **Success path**: The happy path when everything works
2. **Error branches**: 404, 500, connection errors
3. **Access control branches**: Login required, access denied, captcha
4. **UI state branches**: Popups, cookie consent, modal dialogs
5. **Content branches**: Different page layouts, A/B tests

Each non-terminal node should have:
- At least one conditional edge for error/unexpected states
- A default edge for the expected case

## Action Types

- \`navigate\`: Go to a URL
- \`click\`: Click an element (by selector or text)
- \`type\`: Enter text into a field
- \`scroll\`: Scroll the page
- \`extract\`: Extract data from the page
- \`screenshot\`: Capture visual state
- \`wait\`: Wait for a condition

## Condition Types

- \`element_present\`: CSS selector exists
- \`element_absent\`: CSS selector doesn't exist  
- \`url_match\`: URL matches pattern
- \`content_match\`: Page content matches pattern
- \`default\`: Fallback when no other condition matches

## Security Rules

1. NEVER include credentials or sensitive data in the plan
2. Plans for 'purchase' tasks MUST end with confirmation, not completion
3. All nodes get domain constraints based on allowed domains
4. Extract actions should specify exact selectors, not broad patterns

## Output Format

Return a valid JSON object with:
- \`nodes\`: Array of execution nodes
- \`edges\`: Array of conditional edges  
- \`entryPoint\`: ID of the starting node

Every non-terminal node MUST have at least one outgoing edge.
Every plan MUST have at least one terminal node with terminalResult.`;

// ============================================================================
// Provider Interface
// ============================================================================

export interface GeneratePlanRequest {
  systemPrompt: string;
  userPrompt: string;
  schema: typeof DAG_SCHEMA;
  intent: BrowsingIntent;
}

export interface GeneratePlanResponse {
  dag: ExecutionDAG;
  rawResponse: string;
  tokensUsed?: {
    prompt: number;
    completion: number;
  };
}

/**
 * Interface for LLM providers (OpenAI, Anthropic, etc.)
 */
export interface LLMProvider {
  name: string;
  generatePlan(request: GeneratePlanRequest): Promise<GeneratePlanResponse>;
}

// ============================================================================
// Error Types
// ============================================================================

export class PlanGenerationError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
    public readonly attempts?: number
  ) {
    super(message);
    this.name = 'PlanGenerationError';
  }
}

// ============================================================================
// Validation
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  issues: string[];
}

/**
 * Validate an LLM response for structural correctness
 */
export function validateLLMResponse(response: GeneratePlanResponse): ValidationResult {
  const issues: string[] = [];
  const dag = response.dag;

  // Check nodes exist
  if (!dag.nodes || dag.nodes.length === 0) {
    issues.push('DAG has no nodes');
    return { valid: false, issues };
  }

  const nodeIds = new Set(dag.nodes.map(n => n.id));

  // Check entry point exists
  if (!nodeIds.has(dag.entryPoint)) {
    issues.push(`Entry point '${dag.entryPoint}' does not exist in nodes`);
  }

  // Check for terminal nodes
  const terminals = dag.nodes.filter(n => n.isTerminal);
  if (terminals.length === 0) {
    issues.push('DAG has no terminal nodes - every plan needs at least one end state');
  }

  // Check edge references
  for (const edge of dag.edges) {
    if (!nodeIds.has(edge.from)) {
      issues.push(`Edge references nonexistent source node: ${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      issues.push(`Edge references nonexistent/missing target node: ${edge.to}`);
    }
  }

  // Check non-terminal nodes have outgoing edges
  for (const node of dag.nodes) {
    if (!node.isTerminal) {
      const hasOutgoing = dag.edges.some(e => e.from === node.id);
      if (!hasOutgoing) {
        issues.push(`Non-terminal node '${node.id}' has no outgoing edges (dead end)`);
      }
    }
  }

  // Check for unreachable nodes
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
      issues.push(`Node '${node.id}' is unreachable from entry point (orphan)`);
    }
  }

  return { valid: issues.length === 0, issues };
}

// ============================================================================
// Prompt Building
// ============================================================================

/**
 * Build user prompt from browsing intent
 */
export function buildPlannerPrompt(intent: BrowsingIntent): string {
  const lines: string[] = [
    '## Task',
    '',
    `**Goal:** ${intent.goal}`,
    `**Task Type:** ${intent.taskType}`,
    '',
    '## Constraints',
    '',
    `**Allowed Domains:** ${intent.allowedDomains.join(', ')}`,
    `**Allowed Actions:** ${intent.allowedActions.join(', ')}`,
    `**Max Navigation Depth:** ${intent.maxDepth}`,
    `**Timeout:** ${intent.timeout}ms`,
  ];

  if (intent.sensitiveData.length > 0) {
    lines.push('');
    lines.push('## Sensitive Data Protection');
    lines.push('');
    lines.push('The following data types are sensitive and must be protected:');
    for (const data of intent.sensitiveData) {
      lines.push(`- ${data}`);
    }
    lines.push('');
    lines.push('Do NOT include these in any action targets or extraction patterns.');
  }

  lines.push('');
  lines.push('## Original User Request');
  lines.push('');
  lines.push(`"${intent.originalRequest}"`);
  lines.push('');
  lines.push('Generate a complete execution DAG for this task. Remember to enumerate ALL possible branches (errors, access control, unexpected states).');

  return lines.join('\n');
}

// ============================================================================
// DAG Extraction from Raw Response
// ============================================================================

interface ExtractionResult {
  dag?: ExecutionDAG;
  error?: string;
}

/**
 * Extract DAG from LLM response (handles JSON or markdown code blocks)
 */
export function extractDAGFromResponse(rawResponse: string, intent: BrowsingIntent): ExtractionResult {
  try {
    // Try to find JSON in the response
    let jsonStr = rawResponse;
    
    // Check for markdown code block
    const codeBlockMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }
    
    // Parse JSON
    const parsed = JSON.parse(jsonStr);
    
    // Build full DAG with defaults
    const dag: ExecutionDAG = {
      id: `dag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      intent,
      nodes: (parsed.nodes || []).map((n: Partial<ExecutionNode>) => ({
        id: n.id ?? `node_${Math.random().toString(36).slice(2, 8)}`,
        action: n.action ?? { type: 'extract', description: 'Unknown' },
        expectedOutcomes: n.expectedOutcomes ?? [],
        extractionTargets: n.extractionTargets,
        constraints: n.constraints ?? [],
        isTerminal: n.isTerminal ?? false,
        terminalResult: n.terminalResult,
      })),
      edges: (parsed.edges || []).map((e: Partial<ConditionalEdge>, i: number) => ({
        from: e.from ?? '',
        to: e.to ?? '',
        condition: e.condition ?? { type: 'default', description: 'Default' },
        priority: e.priority ?? i,
      })),
      entryPoint: parsed.entryPoint ?? parsed.nodes?.[0]?.id ?? 'start',
      createdAt: Date.now(),
    };
    
    // Add domain constraints to all nodes
    const domainConstraint: Constraint = {
      type: 'domain',
      rule: intent.allowedDomains.join('|'),
      errorMessage: `Navigation restricted to: ${intent.allowedDomains.join(', ')}`,
    };
    
    for (const node of dag.nodes) {
      if (!node.constraints.some(c => c.type === 'domain')) {
        node.constraints.push(domainConstraint);
      }
    }
    
    return { dag };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to parse response' };
  }
}

// ============================================================================
// LLM Planner
// ============================================================================

export interface LLMPlannerOptions {
  provider: LLMProvider;
  maxRetries?: number;
  fallbackToTemplate?: boolean;
  validateDomains?: boolean;
}

export interface PlanResult {
  dag: ExecutionDAG;
  usedFallback?: boolean;
  tokensUsed?: {
    prompt: number;
    completion: number;
  };
  attempts?: number;
}

/**
 * LLM-based planner for generating execution DAGs
 */
export class LLMPlanner {
  private provider: LLMProvider;
  private maxRetries: number;
  private fallbackToTemplate: boolean;
  private validateDomains: boolean;

  constructor(options: LLMPlannerOptions) {
    this.provider = options.provider;
    this.maxRetries = options.maxRetries ?? 3;
    this.fallbackToTemplate = options.fallbackToTemplate ?? true;
    this.validateDomains = options.validateDomains ?? true;
  }

  /**
   * Generate an execution DAG for the given browsing intent
   */
  async generatePlan(intent: BrowsingIntent): Promise<PlanResult> {
    const request: GeneratePlanRequest = {
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userPrompt: buildPlannerPrompt(intent),
      schema: DAG_SCHEMA,
      intent,
    };

    let lastError: Error | undefined;
    let attempts = 0;

    // Try LLM generation with retries
    while (attempts < this.maxRetries) {
      attempts++;
      try {
        const response = await this.provider.generatePlan(request);
        
        // Validate the response
        const validation = validateLLMResponse(response);
        if (validation.valid) {
          // Ensure DAG uses the provided intent and has proper constraints
          const dag = this.finalizeDAG(response.dag, intent);
          return {
            dag,
            tokensUsed: response.tokensUsed,
            attempts,
          };
        }
        
        // Invalid response - will retry or fallback
        lastError = new Error(`Validation failed: ${validation.issues.join(', ')}`);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }

    // All retries exhausted
    if (this.fallbackToTemplate) {
      // Use template-based DAG builder as fallback
      const dag = buildDAG(intent);
      return {
        dag,
        usedFallback: true,
        attempts,
      };
    }

    throw new PlanGenerationError(
      `Failed to generate plan after ${attempts} attempts: ${lastError?.message}`,
      lastError,
      attempts
    );
  }

  /**
   * Finalize a DAG by setting the proper intent and adding security constraints
   */
  private finalizeDAG(dag: ExecutionDAG, intent: BrowsingIntent): ExecutionDAG {
    // Create domain constraint
    const domainConstraint: Constraint = {
      type: 'domain',
      rule: intent.allowedDomains.join('|'),
      errorMessage: `Navigation restricted to: ${intent.allowedDomains.join(', ')}`,
    };

    // Update all nodes with domain constraints
    const updatedNodes = dag.nodes.map(node => ({
      ...node,
      constraints: [
        ...node.constraints.filter(c => c.type !== 'domain'),
        domainConstraint,
      ],
    }));

    return {
      ...dag,
      intent, // Use the provided intent, not the one from LLM response
      nodes: updatedNodes,
    };
  }
}

// ============================================================================
// Convenience function for direct DAG generation
// ============================================================================

/**
 * Generate a DAG using the provided LLM provider
 */
export async function generatePlanWithLLM(
  intent: BrowsingIntent,
  provider: LLMProvider,
  options?: Partial<LLMPlannerOptions>
): Promise<ExecutionDAG> {
  const planner = new LLMPlanner({ provider, ...options });
  const result = await planner.generatePlan(intent);
  return result.dag;
}
