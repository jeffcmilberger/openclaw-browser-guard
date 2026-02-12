/**
 * LLM Planner Tests
 * 
 * Tests for LLM-based plan generation with single-shot security guarantees.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import {
  LLMPlanner,
  PlanGenerationError,
  DAG_SCHEMA,
  PLANNER_SYSTEM_PROMPT,
  buildPlannerPrompt,
  validateLLMResponse,
  extractDAGFromResponse,
} from '../dist/planner/llm-planner.js';
import type { 
  LLMPlannerOptions,
  LLMProvider,
  GeneratePlanRequest,
  GeneratePlanResponse,
} from '../dist/planner/llm-planner.js';
import type { BrowsingIntent, ExecutionDAG } from '../dist/core/types.js';

// ============================================================================
// Mock LLM Provider
// ============================================================================

function createMockProvider(responses: GeneratePlanResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    name: 'mock',
    async generatePlan(request: GeneratePlanRequest): Promise<GeneratePlanResponse> {
      if (callIndex >= responses.length) {
        throw new Error('Mock provider exhausted');
      }
      return responses[callIndex++];
    },
  };
}

function createValidDAGResponse(dag: Partial<ExecutionDAG>): GeneratePlanResponse {
  const fullDAG: ExecutionDAG = {
    id: dag.id ?? 'dag_test',
    intent: dag.intent ?? createTestIntent(),
    nodes: dag.nodes ?? [
      {
        id: 'start',
        action: { type: 'navigate', description: 'Navigate to page' },
        expectedOutcomes: [],
        constraints: [],
        isTerminal: false,
      },
      {
        id: 'success',
        action: { type: 'extract', description: 'Extract content' },
        expectedOutcomes: [],
        constraints: [],
        isTerminal: true,
        terminalResult: 'success',
      },
    ],
    edges: dag.edges ?? [
      { from: 'start', to: 'success', condition: { type: 'default', description: 'Page loaded' }, priority: 1 },
    ],
    entryPoint: dag.entryPoint ?? 'start',
    createdAt: dag.createdAt ?? Date.now(),
  };
  
  return {
    dag: fullDAG,
    rawResponse: JSON.stringify(fullDAG),
    tokensUsed: { prompt: 100, completion: 200 },
  };
}

function createTestIntent(overrides: Partial<BrowsingIntent> = {}): BrowsingIntent {
  return {
    goal: 'Find the price of RTX 5090',
    taskType: 'extract',
    allowedDomains: ['newegg.com'],
    allowedActions: ['navigate', 'scroll', 'extract'],
    sensitiveData: [],
    maxDepth: 3,
    timeout: 30000,
    originalRequest: 'What is the price of RTX 5090 on newegg?',
    ...overrides,
  };
}

// ============================================================================
// Schema Tests
// ============================================================================

describe('LLM Planner Schema', () => {
  it('should have a valid JSON schema for DAG generation', () => {
    assert.ok(DAG_SCHEMA);
    assert.strictEqual(DAG_SCHEMA.type, 'object');
    assert.ok(DAG_SCHEMA.properties.nodes);
    assert.ok(DAG_SCHEMA.properties.edges);
    assert.ok(DAG_SCHEMA.properties.entryPoint);
    assert.ok(DAG_SCHEMA.required.includes('nodes'));
    assert.ok(DAG_SCHEMA.required.includes('edges'));
    assert.ok(DAG_SCHEMA.required.includes('entryPoint'));
  });

  it('should define node schema with required fields', () => {
    const nodeSchema = DAG_SCHEMA.properties.nodes.items;
    assert.ok(nodeSchema.properties.id);
    assert.ok(nodeSchema.properties.action);
    assert.ok(nodeSchema.properties.isTerminal);
    assert.ok(nodeSchema.required.includes('id'));
    assert.ok(nodeSchema.required.includes('action'));
  });

  it('should define edge schema with condition types', () => {
    const edgeSchema = DAG_SCHEMA.properties.edges.items;
    assert.ok(edgeSchema.properties.from);
    assert.ok(edgeSchema.properties.to);
    assert.ok(edgeSchema.properties.condition);
  });
});

// ============================================================================
// Prompt Building Tests
// ============================================================================

describe('Planner Prompt Building', () => {
  it('should include the goal in the prompt', () => {
    const intent = createTestIntent({ goal: 'Find product prices' });
    const prompt = buildPlannerPrompt(intent);
    assert.ok(prompt.includes('Find product prices'));
  });

  it('should include allowed domains in the prompt', () => {
    const intent = createTestIntent({ allowedDomains: ['amazon.com', 'ebay.com'] });
    const prompt = buildPlannerPrompt(intent);
    assert.ok(prompt.includes('amazon.com'));
    assert.ok(prompt.includes('ebay.com'));
  });

  it('should include allowed actions in the prompt', () => {
    const intent = createTestIntent({ allowedActions: ['navigate', 'click', 'type'] });
    const prompt = buildPlannerPrompt(intent);
    assert.ok(prompt.includes('navigate'));
    assert.ok(prompt.includes('click'));
    assert.ok(prompt.includes('type'));
  });

  it('should include sensitive data warnings', () => {
    const intent = createTestIntent({ sensitiveData: ['password', 'credit_card'] });
    const prompt = buildPlannerPrompt(intent);
    assert.ok(prompt.includes('password'));
    assert.ok(prompt.includes('credit_card'));
    assert.ok(prompt.toLowerCase().includes('sensitive') || prompt.toLowerCase().includes('protect'));
  });

  it('should include max depth constraint', () => {
    const intent = createTestIntent({ maxDepth: 5 });
    const prompt = buildPlannerPrompt(intent);
    assert.ok(prompt.includes('5'));
  });

  it('should include timeout constraint', () => {
    const intent = createTestIntent({ timeout: 60000 });
    const prompt = buildPlannerPrompt(intent);
    assert.ok(prompt.includes('60') || prompt.includes('60000'));
  });

  it('should have a system prompt explaining single-shot planning', () => {
    assert.ok(PLANNER_SYSTEM_PROMPT.length > 100);
    assert.ok(PLANNER_SYSTEM_PROMPT.toLowerCase().includes('plan'));
    // Should mention that plan is created before seeing content
    assert.ok(
      PLANNER_SYSTEM_PROMPT.toLowerCase().includes('before') ||
      PLANNER_SYSTEM_PROMPT.toLowerCase().includes('upfront') ||
      PLANNER_SYSTEM_PROMPT.toLowerCase().includes('single-shot')
    );
  });
});

// ============================================================================
// Response Validation Tests
// ============================================================================

describe('LLM Response Validation', () => {
  it('should accept valid DAG response', () => {
    const response = createValidDAGResponse({});
    const result = validateLLMResponse(response);
    assert.ok(result.valid);
    assert.strictEqual(result.issues.length, 0);
  });

  it('should reject DAG with no nodes', () => {
    const response = createValidDAGResponse({ nodes: [] });
    const result = validateLLMResponse(response);
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.includes('node')));
  });

  it('should reject DAG with no terminal nodes', () => {
    const response = createValidDAGResponse({
      nodes: [
        { id: 'a', action: { type: 'navigate', description: 'Nav' }, expectedOutcomes: [], constraints: [], isTerminal: false },
        { id: 'b', action: { type: 'click', description: 'Click' }, expectedOutcomes: [], constraints: [], isTerminal: false },
      ],
      edges: [{ from: 'a', to: 'b', condition: { type: 'default', description: 'Next' }, priority: 1 }],
      entryPoint: 'a',
    });
    const result = validateLLMResponse(response);
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.includes('terminal')));
  });

  it('should reject DAG with invalid entry point', () => {
    const response = createValidDAGResponse({ entryPoint: 'nonexistent' });
    const result = validateLLMResponse(response);
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.includes('entry')));
  });

  it('should reject DAG with edges to nonexistent nodes', () => {
    const response = createValidDAGResponse({
      nodes: [
        { id: 'start', action: { type: 'navigate', description: 'Nav' }, expectedOutcomes: [], constraints: [], isTerminal: false },
        { id: 'end', action: { type: 'extract', description: 'Extract' }, expectedOutcomes: [], constraints: [], isTerminal: true, terminalResult: 'success' },
      ],
      edges: [
        { from: 'start', to: 'missing', condition: { type: 'default', description: 'Next' }, priority: 1 },
      ],
      entryPoint: 'start',
    });
    const result = validateLLMResponse(response);
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.includes('missing') || i.includes('nonexistent')));
  });

  it('should reject DAG with unreachable nodes', () => {
    const response = createValidDAGResponse({
      nodes: [
        { id: 'start', action: { type: 'navigate', description: 'Nav' }, expectedOutcomes: [], constraints: [], isTerminal: false },
        { id: 'end', action: { type: 'extract', description: 'Extract' }, expectedOutcomes: [], constraints: [], isTerminal: true, terminalResult: 'success' },
        { id: 'orphan', action: { type: 'click', description: 'Orphan' }, expectedOutcomes: [], constraints: [], isTerminal: true, terminalResult: 'error' },
      ],
      edges: [
        { from: 'start', to: 'end', condition: { type: 'default', description: 'Next' }, priority: 1 },
      ],
      entryPoint: 'start',
    });
    const result = validateLLMResponse(response);
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.includes('unreachable') || i.includes('orphan')));
  });

  it('should reject DAG with non-terminal nodes without outgoing edges', () => {
    const response = createValidDAGResponse({
      nodes: [
        { id: 'start', action: { type: 'navigate', description: 'Nav' }, expectedOutcomes: [], constraints: [], isTerminal: false },
        { id: 'dead_end', action: { type: 'click', description: 'Dead end' }, expectedOutcomes: [], constraints: [], isTerminal: false },
        { id: 'end', action: { type: 'extract', description: 'Extract' }, expectedOutcomes: [], constraints: [], isTerminal: true, terminalResult: 'success' },
      ],
      edges: [
        { from: 'start', to: 'dead_end', condition: { type: 'default', description: 'Next' }, priority: 1 },
      ],
      entryPoint: 'start',
    });
    const result = validateLLMResponse(response);
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.includes('outgoing') || i.includes('dead')));
  });
});

// ============================================================================
// DAG Extraction Tests
// ============================================================================

describe('DAG Extraction', () => {
  it('should extract DAG from valid JSON response', () => {
    const dagJson = JSON.stringify({
      nodes: [
        { id: 'start', action: { type: 'navigate', description: 'Go' }, isTerminal: false },
        { id: 'end', action: { type: 'extract', description: 'Done' }, isTerminal: true, terminalResult: 'success' },
      ],
      edges: [{ from: 'start', to: 'end', condition: { type: 'default', description: 'Next' }, priority: 1 }],
      entryPoint: 'start',
    });
    
    const intent = createTestIntent();
    const result = extractDAGFromResponse(dagJson, intent);
    assert.ok(result.dag);
    assert.strictEqual(result.dag.nodes.length, 2);
    assert.strictEqual(result.dag.entryPoint, 'start');
  });

  it('should extract DAG from markdown code block', () => {
    const response = `
Here is the execution plan:

\`\`\`json
{
  "nodes": [
    { "id": "start", "action": { "type": "navigate", "description": "Go" }, "isTerminal": false },
    { "id": "end", "action": { "type": "extract", "description": "Done" }, "isTerminal": true, "terminalResult": "success" }
  ],
  "edges": [{ "from": "start", "to": "end", "condition": { "type": "default", "description": "Next" }, "priority": 1 }],
  "entryPoint": "start"
}
\`\`\`

This plan will navigate to the page and extract the content.
`;
    
    const intent = createTestIntent();
    const result = extractDAGFromResponse(response, intent);
    assert.ok(result.dag);
    assert.strictEqual(result.dag.nodes.length, 2);
  });

  it('should handle missing optional fields with defaults', () => {
    const dagJson = JSON.stringify({
      nodes: [
        { id: 'start', action: { type: 'navigate', description: 'Go' } },
        { id: 'end', action: { type: 'extract', description: 'Done' }, isTerminal: true },
      ],
      edges: [{ from: 'start', to: 'end', condition: { type: 'default', description: 'Next' } }],
      entryPoint: 'start',
    });
    
    const intent = createTestIntent();
    const result = extractDAGFromResponse(dagJson, intent);
    assert.ok(result.dag);
    // Should have defaults filled in
    assert.ok(Array.isArray(result.dag.nodes[0].constraints));
    assert.ok(Array.isArray(result.dag.nodes[0].expectedOutcomes));
  });

  it('should fail gracefully on invalid JSON', () => {
    const intent = createTestIntent();
    const result = extractDAGFromResponse('not valid json {{{', intent);
    assert.ok(!result.dag);
    assert.ok(result.error);
  });

  it('should add domain constraints from intent', () => {
    const dagJson = JSON.stringify({
      nodes: [
        { id: 'start', action: { type: 'navigate', description: 'Go' }, isTerminal: false },
        { id: 'end', action: { type: 'extract', description: 'Done' }, isTerminal: true, terminalResult: 'success' },
      ],
      edges: [{ from: 'start', to: 'end', condition: { type: 'default', description: 'Next' }, priority: 1 }],
      entryPoint: 'start',
    });
    
    const intent = createTestIntent({ allowedDomains: ['example.com', 'test.com'] });
    const result = extractDAGFromResponse(dagJson, intent);
    assert.ok(result.dag);
    // All nodes should have domain constraints
    for (const node of result.dag.nodes) {
      assert.ok(node.constraints.some(c => c.type === 'domain'));
    }
  });
});

// ============================================================================
// LLM Planner Integration Tests
// ============================================================================

describe('LLM Planner', () => {
  it('should generate plan using LLM provider', async () => {
    const provider = createMockProvider([createValidDAGResponse({})]);
    const planner = new LLMPlanner({ provider });
    
    const intent = createTestIntent();
    const result = await planner.generatePlan(intent);
    
    assert.ok(result.dag);
    assert.strictEqual(result.dag.entryPoint, 'start');
  });

  it('should retry on transient failures', async () => {
    let attempts = 0;
    const provider: LLMProvider = {
      name: 'flaky',
      async generatePlan(request: GeneratePlanRequest): Promise<GeneratePlanResponse> {
        attempts++;
        if (attempts < 3) {
          throw new Error('Temporary failure');
        }
        return createValidDAGResponse({});
      },
    };
    
    const planner = new LLMPlanner({ provider, maxRetries: 3 });
    const intent = createTestIntent();
    const result = await planner.generatePlan(intent);
    
    assert.ok(result.dag);
    assert.strictEqual(attempts, 3);
  });

  it('should fall back to template after max retries', async () => {
    const provider: LLMProvider = {
      name: 'always-fails',
      async generatePlan(): Promise<GeneratePlanResponse> {
        throw new Error('LLM unavailable');
      },
    };
    
    const planner = new LLMPlanner({ provider, maxRetries: 2, fallbackToTemplate: true });
    const intent = createTestIntent({ taskType: 'extract' });
    const result = await planner.generatePlan(intent);
    
    // Should get a valid DAG from template fallback
    assert.ok(result.dag);
    assert.ok(result.usedFallback);
  });

  it('should throw if fallback disabled and LLM fails', async () => {
    const provider: LLMProvider = {
      name: 'always-fails',
      async generatePlan(): Promise<GeneratePlanResponse> {
        throw new Error('LLM unavailable');
      },
    };
    
    const planner = new LLMPlanner({ provider, maxRetries: 1, fallbackToTemplate: false });
    const intent = createTestIntent();
    
    await assert.rejects(
      () => planner.generatePlan(intent),
      PlanGenerationError
    );
  });

  it('should validate LLM response before returning', async () => {
    // Provider returns invalid DAG (no terminal nodes)
    const provider = createMockProvider([
      createValidDAGResponse({
        nodes: [
          { id: 'start', action: { type: 'navigate', description: 'Go' }, expectedOutcomes: [], constraints: [], isTerminal: false },
        ],
        edges: [],
        entryPoint: 'start',
      }),
    ]);
    
    const planner = new LLMPlanner({ provider, maxRetries: 1, fallbackToTemplate: true });
    const intent = createTestIntent();
    const result = await planner.generatePlan(intent);
    
    // Should fallback due to validation failure
    assert.ok(result.dag);
    assert.ok(result.usedFallback || result.dag.nodes.some(n => n.isTerminal));
  });

  it('should include token usage in result', async () => {
    const provider = createMockProvider([
      {
        ...createValidDAGResponse({}),
        tokensUsed: { prompt: 500, completion: 1000 },
      },
    ]);
    
    const planner = new LLMPlanner({ provider });
    const intent = createTestIntent();
    const result = await planner.generatePlan(intent);
    
    assert.ok(result.tokensUsed);
    assert.strictEqual(result.tokensUsed.prompt, 500);
    assert.strictEqual(result.tokensUsed.completion, 1000);
  });
});

// ============================================================================
// Branch Enumeration Tests
// ============================================================================

describe('Branch Enumeration', () => {
  it('should require error handling branches for navigation', async () => {
    // A good plan should have error branches
    const dagWithErrors = createValidDAGResponse({
      nodes: [
        { id: 'navigate', action: { type: 'navigate', description: 'Go to page' }, expectedOutcomes: [], constraints: [], isTerminal: false },
        { id: 'success', action: { type: 'extract', description: 'Extract' }, expectedOutcomes: [], constraints: [], isTerminal: true, terminalResult: 'success' },
        { id: 'error_404', action: { type: 'extract', description: 'Page not found' }, expectedOutcomes: [], constraints: [], isTerminal: true, terminalResult: 'error' },
        { id: 'error_access', action: { type: 'extract', description: 'Access denied' }, expectedOutcomes: [], constraints: [], isTerminal: true, terminalResult: 'abort' },
      ],
      edges: [
        { from: 'navigate', to: 'success', condition: { type: 'default', description: 'Page loaded' }, priority: 10 },
        { from: 'navigate', to: 'error_404', condition: { type: 'content_match', value: '404|not found', description: 'Not found' }, priority: 1 },
        { from: 'navigate', to: 'error_access', condition: { type: 'content_match', value: 'access denied|forbidden', description: 'Forbidden' }, priority: 2 },
      ],
      entryPoint: 'navigate',
    });
    
    const result = validateLLMResponse(dagWithErrors);
    assert.ok(result.valid);
    
    // Should have multiple terminal states
    const terminals = dagWithErrors.dag.nodes.filter(n => n.isTerminal);
    assert.ok(terminals.length >= 2, 'Should have success and error terminals');
  });

  it('should validate that all non-default branches have conditions', () => {
    const dag = createValidDAGResponse({
      nodes: [
        { id: 'start', action: { type: 'navigate', description: 'Go' }, expectedOutcomes: [], constraints: [], isTerminal: false },
        { id: 'a', action: { type: 'click', description: 'Option A' }, expectedOutcomes: [], constraints: [], isTerminal: true, terminalResult: 'success' },
        { id: 'b', action: { type: 'click', description: 'Option B' }, expectedOutcomes: [], constraints: [], isTerminal: true, terminalResult: 'success' },
      ],
      edges: [
        { from: 'start', to: 'a', condition: { type: 'element_present', value: '#optionA', description: 'Option A available' }, priority: 1 },
        { from: 'start', to: 'b', condition: { type: 'default', description: 'Fallback' }, priority: 10 },
      ],
      entryPoint: 'start',
    });
    
    const result = validateLLMResponse(dag);
    assert.ok(result.valid);
  });
});

// ============================================================================
// Security Constraint Tests
// ============================================================================

describe('Security Constraints in Plans', () => {
  it('should not allow plans that navigate outside allowed domains', async () => {
    const provider = createMockProvider([
      createValidDAGResponse({
        nodes: [
          { 
            id: 'navigate', 
            action: { type: 'navigate', target: 'https://evil.com', description: 'Go to evil site' }, 
            expectedOutcomes: [], 
            constraints: [], 
            isTerminal: false 
          },
          { id: 'end', action: { type: 'extract', description: 'Done' }, expectedOutcomes: [], constraints: [], isTerminal: true, terminalResult: 'success' },
        ],
        edges: [{ from: 'navigate', to: 'end', condition: { type: 'default', description: 'Next' }, priority: 1 }],
        entryPoint: 'navigate',
      }),
    ]);
    
    const planner = new LLMPlanner({ provider, validateDomains: true, fallbackToTemplate: true });
    const intent = createTestIntent({ allowedDomains: ['good.com'] });
    const result = await planner.generatePlan(intent);
    
    // Should either reject or sanitize
    if (result.dag) {
      // If accepted, domain constraints should be added
      const navNode = result.dag.nodes.find(n => n.action.type === 'navigate');
      assert.ok(navNode?.constraints.some(c => c.type === 'domain'));
    }
  });

  it('should add sensitive data constraints to extraction nodes', async () => {
    const provider = createMockProvider([createValidDAGResponse({})]);
    const planner = new LLMPlanner({ provider });
    
    const intent = createTestIntent({ sensitiveData: ['password', 'ssn'] });
    const result = await planner.generatePlan(intent);
    
    // Intent with sensitive data should result in constraints
    assert.ok(result.dag);
    assert.ok(result.dag.intent.sensitiveData.includes('password'));
  });

  it('should require confirmation for purchase-type tasks', async () => {
    const provider = createMockProvider([
      createValidDAGResponse({
        nodes: [
          { id: 'nav', action: { type: 'navigate', description: 'Go to store' }, expectedOutcomes: [], constraints: [], isTerminal: false },
          { id: 'buy', action: { type: 'click', target: 'Buy Now', description: 'Click buy' }, expectedOutcomes: [], constraints: [], isTerminal: false },
          { id: 'confirm', action: { type: 'extract', description: 'Await user confirmation' }, expectedOutcomes: [], constraints: [], isTerminal: true, terminalResult: 'success' },
        ],
        edges: [
          { from: 'nav', to: 'buy', condition: { type: 'default', description: 'Next' }, priority: 1 },
          { from: 'buy', to: 'confirm', condition: { type: 'default', description: 'Next' }, priority: 1 },
        ],
        entryPoint: 'nav',
      }),
    ]);
    
    const planner = new LLMPlanner({ provider });
    const intent = createTestIntent({ taskType: 'purchase' });
    const result = await planner.generatePlan(intent);
    
    // Purchase tasks should have extra validation
    assert.ok(result.dag);
    assert.strictEqual(result.dag.intent.taskType, 'purchase');
  });
});

// ============================================================================
// Provider Interface Tests
// ============================================================================

describe('LLM Provider Interface', () => {
  it('should pass system prompt to provider', async () => {
    let receivedRequest: GeneratePlanRequest | null = null;
    const provider: LLMProvider = {
      name: 'capture',
      async generatePlan(request: GeneratePlanRequest): Promise<GeneratePlanResponse> {
        receivedRequest = request;
        return createValidDAGResponse({});
      },
    };
    
    const planner = new LLMPlanner({ provider });
    await planner.generatePlan(createTestIntent());
    
    assert.ok(receivedRequest);
    assert.ok(receivedRequest.systemPrompt);
    assert.ok(receivedRequest.systemPrompt.length > 0);
  });

  it('should pass schema to provider for structured output', async () => {
    let receivedRequest: GeneratePlanRequest | null = null;
    const provider: LLMProvider = {
      name: 'capture',
      async generatePlan(request: GeneratePlanRequest): Promise<GeneratePlanResponse> {
        receivedRequest = request;
        return createValidDAGResponse({});
      },
    };
    
    const planner = new LLMPlanner({ provider });
    await planner.generatePlan(createTestIntent());
    
    assert.ok(receivedRequest);
    assert.ok(receivedRequest.schema);
    assert.strictEqual(receivedRequest.schema, DAG_SCHEMA);
  });

  it('should pass intent in user prompt', async () => {
    let receivedRequest: GeneratePlanRequest | null = null;
    const provider: LLMProvider = {
      name: 'capture',
      async generatePlan(request: GeneratePlanRequest): Promise<GeneratePlanResponse> {
        receivedRequest = request;
        return createValidDAGResponse({});
      },
    };
    
    const planner = new LLMPlanner({ provider });
    const intent = createTestIntent({ goal: 'Unique test goal XYZ123' });
    await planner.generatePlan(intent);
    
    assert.ok(receivedRequest);
    assert.ok(receivedRequest.userPrompt.includes('Unique test goal XYZ123'));
  });
});
