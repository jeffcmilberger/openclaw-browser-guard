/**
 * LLM Provider Tests
 * 
 * Tests for the provider implementations.
 * Note: OpenAI and Anthropic providers require API keys for real testing.
 * These tests focus on the callable provider and provider utilities.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  CallableProvider,
  createCallableProvider,
  createMockProvider,
  createLoggingProvider,
  createCachingProvider,
} from '../dist/planner/providers/index.js';
import type { CompletionFunction, LLMProvider, GeneratePlanRequest } from '../dist/index.js';
import { DAG_SCHEMA, PLANNER_SYSTEM_PROMPT, buildPlannerPrompt } from '../dist/planner/llm-planner.js';
import type { BrowsingIntent } from '../dist/core/types.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createTestIntent(overrides: Partial<BrowsingIntent> = {}): BrowsingIntent {
  return {
    goal: 'Test goal',
    taskType: 'extract',
    allowedDomains: ['example.com'],
    allowedActions: ['navigate', 'extract'],
    sensitiveData: [],
    maxDepth: 3,
    timeout: 30000,
    originalRequest: 'Test request',
    ...overrides,
  };
}

function createTestRequest(intent?: BrowsingIntent): GeneratePlanRequest {
  const i = intent ?? createTestIntent();
  return {
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    userPrompt: buildPlannerPrompt(i),
    schema: DAG_SCHEMA,
    intent: i,
  };
}

const VALID_DAG_JSON = JSON.stringify({
  nodes: [
    { id: 'start', action: { type: 'navigate', description: 'Go to page' }, isTerminal: false },
    { id: 'end', action: { type: 'extract', description: 'Extract content' }, isTerminal: true, terminalResult: 'success' },
  ],
  edges: [
    { from: 'start', to: 'end', condition: { type: 'default', description: 'Page loaded' }, priority: 1 },
  ],
  entryPoint: 'start',
});

// ============================================================================
// CallableProvider Tests
// ============================================================================

describe('CallableProvider', () => {
  it('should call the completion function with correct arguments', async () => {
    let receivedArgs: { system: string; user: string; options: unknown } | null = null;
    
    const complete: CompletionFunction = async (system, user, options) => {
      receivedArgs = { system, user, options };
      return { content: VALID_DAG_JSON };
    };
    
    const provider = new CallableProvider({ complete });
    const request = createTestRequest();
    await provider.generatePlan(request);
    
    assert.ok(receivedArgs);
    assert.strictEqual(receivedArgs.system, request.systemPrompt);
    assert.strictEqual(receivedArgs.user, request.userPrompt);
    assert.deepStrictEqual(receivedArgs.options, { jsonMode: true, maxTokens: undefined, temperature: 0 });
  });

  it('should pass custom options to completion function', async () => {
    let receivedOptions: unknown = null;
    
    const complete: CompletionFunction = async (_s, _u, options) => {
      receivedOptions = options;
      return { content: VALID_DAG_JSON };
    };
    
    const provider = new CallableProvider({
      complete,
      jsonMode: false,
      maxTokens: 2000,
      temperature: 0.5,
    });
    
    await provider.generatePlan(createTestRequest());
    
    assert.deepStrictEqual(receivedOptions, {
      jsonMode: false,
      maxTokens: 2000,
      temperature: 0.5,
    });
  });

  it('should extract DAG from completion response', async () => {
    const provider = createCallableProvider(
      async () => ({ content: VALID_DAG_JSON })
    );
    
    const result = await provider.generatePlan(createTestRequest());
    
    assert.ok(result.dag);
    assert.strictEqual(result.dag.nodes.length, 2);
    assert.strictEqual(result.dag.entryPoint, 'start');
  });

  it('should include token usage if provided', async () => {
    const provider = createCallableProvider(
      async () => ({
        content: VALID_DAG_JSON,
        tokensUsed: { prompt: 100, completion: 200 },
      })
    );
    
    const result = await provider.generatePlan(createTestRequest());
    
    assert.ok(result.tokensUsed);
    assert.strictEqual(result.tokensUsed.prompt, 100);
    assert.strictEqual(result.tokensUsed.completion, 200);
  });

  it('should throw on invalid DAG response', async () => {
    const provider = createCallableProvider(
      async () => ({ content: 'not valid json' })
    );
    
    await assert.rejects(
      () => provider.generatePlan(createTestRequest()),
      /Failed to extract DAG/
    );
  });

  it('should use custom name', () => {
    const provider = createCallableProvider(
      async () => ({ content: VALID_DAG_JSON }),
      'my-custom-provider'
    );
    
    assert.strictEqual(provider.name, 'my-custom-provider');
  });
});

// ============================================================================
// Mock Provider Tests
// ============================================================================

describe('createMockProvider', () => {
  it('should return fixed response regardless of input', async () => {
    const provider = createMockProvider(VALID_DAG_JSON);
    
    const result1 = await provider.generatePlan(createTestRequest(createTestIntent({ goal: 'Goal 1' })));
    const result2 = await provider.generatePlan(createTestRequest(createTestIntent({ goal: 'Goal 2' })));
    
    assert.strictEqual(result1.rawResponse, VALID_DAG_JSON);
    assert.strictEqual(result2.rawResponse, VALID_DAG_JSON);
  });

  it('should have name "mock"', () => {
    const provider = createMockProvider(VALID_DAG_JSON);
    assert.strictEqual(provider.name, 'mock');
  });
});

// ============================================================================
// Logging Provider Tests
// ============================================================================

describe('createLoggingProvider', () => {
  it('should log requests and results', async () => {
    const logs: string[] = [];
    const inner = createMockProvider(VALID_DAG_JSON);
    const provider = createLoggingProvider(inner, msg => logs.push(msg));
    
    await provider.generatePlan(createTestRequest(createTestIntent({ goal: 'Test logging' })));
    
    assert.ok(logs.some(l => l.includes('Test logging')));
    assert.ok(logs.some(l => l.includes('System prompt length')));
    assert.ok(logs.some(l => l.includes('Plan generated')));
  });

  it('should log errors on failure', async () => {
    const logs: string[] = [];
    const inner: LLMProvider = {
      name: 'failing',
      generatePlan: async () => { throw new Error('Test error'); },
    };
    const provider = createLoggingProvider(inner, msg => logs.push(msg));
    
    await assert.rejects(() => provider.generatePlan(createTestRequest()));
    
    assert.ok(logs.some(l => l.includes('failed')));
    assert.ok(logs.some(l => l.includes('Test error')));
  });

  it('should include inner provider name', () => {
    const inner = createMockProvider(VALID_DAG_JSON);
    const provider = createLoggingProvider(inner);
    
    assert.strictEqual(provider.name, 'logging-mock');
  });
});

// ============================================================================
// Caching Provider Tests
// ============================================================================

describe('createCachingProvider', () => {
  it('should cache results by intent', async () => {
    let callCount = 0;
    const inner: LLMProvider = {
      name: 'counting',
      generatePlan: async (request) => {
        callCount++;
        return {
          dag: {
            id: `dag_${callCount}`,
            intent: request.intent,
            nodes: [
              { id: 'start', action: { type: 'navigate', description: 'Go' }, expectedOutcomes: [], constraints: [], isTerminal: false },
              { id: 'end', action: { type: 'extract', description: 'Done' }, expectedOutcomes: [], constraints: [], isTerminal: true, terminalResult: 'success' as const },
            ],
            edges: [{ from: 'start', to: 'end', condition: { type: 'default' as const, description: 'Next' }, priority: 1 }],
            entryPoint: 'start',
            createdAt: Date.now(),
          },
          rawResponse: VALID_DAG_JSON,
        };
      },
    };
    
    const provider = createCachingProvider(inner);
    const intent = createTestIntent({ goal: 'Cached goal' });
    
    // First call should hit the inner provider
    await provider.generatePlan(createTestRequest(intent));
    assert.strictEqual(callCount, 1);
    
    // Second call with same intent should use cache
    await provider.generatePlan(createTestRequest(intent));
    assert.strictEqual(callCount, 1);
    
    // Different intent should hit the inner provider again
    const differentIntent = createTestIntent({ goal: 'Different goal' });
    await provider.generatePlan(createTestRequest(differentIntent));
    assert.strictEqual(callCount, 2);
  });

  it('should return cloned DAG from cache', async () => {
    const inner = createMockProvider(VALID_DAG_JSON);
    const provider = createCachingProvider(inner);
    const intent = createTestIntent();
    
    const result1 = await provider.generatePlan(createTestRequest(intent));
    const result2 = await provider.generatePlan(createTestRequest(intent));
    
    // Modify result1's DAG
    result1.dag.nodes[0].id = 'modified';
    
    // result2 should not be affected
    assert.strictEqual(result2.dag.nodes[0].id, 'start');
  });

  it('should use provided cache map', async () => {
    const cache = new Map();
    const inner = createMockProvider(VALID_DAG_JSON);
    const provider = createCachingProvider(inner, cache);
    
    await provider.generatePlan(createTestRequest(createTestIntent({ goal: 'Goal 1' })));
    await provider.generatePlan(createTestRequest(createTestIntent({ goal: 'Goal 2' })));
    
    assert.strictEqual(cache.size, 2);
  });
});

// ============================================================================
// Provider Composition Tests
// ============================================================================

describe('Provider Composition', () => {
  it('should compose logging and caching', async () => {
    const logs: string[] = [];
    let callCount = 0;
    
    const base: LLMProvider = {
      name: 'base',
      generatePlan: async (request) => {
        callCount++;
        return {
          dag: {
            id: `dag_${callCount}`,
            intent: request.intent,
            nodes: [
              { id: 'start', action: { type: 'navigate', description: 'Go' }, expectedOutcomes: [], constraints: [], isTerminal: false },
              { id: 'end', action: { type: 'extract', description: 'Done' }, expectedOutcomes: [], constraints: [], isTerminal: true, terminalResult: 'success' as const },
            ],
            edges: [{ from: 'start', to: 'end', condition: { type: 'default' as const, description: 'Next' }, priority: 1 }],
            entryPoint: 'start',
            createdAt: Date.now(),
          },
          rawResponse: VALID_DAG_JSON,
        };
      },
    };
    
    // Compose: logging wraps caching wraps base
    const cached = createCachingProvider(base);
    const logged = createLoggingProvider(cached, msg => logs.push(msg));
    
    const intent = createTestIntent();
    
    await logged.generatePlan(createTestRequest(intent));
    await logged.generatePlan(createTestRequest(intent));
    
    // Should only call base once due to caching
    assert.strictEqual(callCount, 1);
    
    // Should log both requests
    const generateLogs = logs.filter(l => l.includes('Generating plan'));
    assert.strictEqual(generateLogs.length, 2);
  });
});
