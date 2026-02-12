/**
 * Callable Provider for Browser Guard
 * 
 * A flexible provider that wraps any async function for generating plans.
 * Useful for integrating with existing LLM infrastructure (OpenClaw, LangChain, etc.)
 */

import type { LLMProvider, GeneratePlanRequest, GeneratePlanResponse } from '../llm-planner.js';
import { extractDAGFromResponse } from '../llm-planner.js';

/**
 * Function signature for LLM completion
 */
export type CompletionFunction = (
  systemPrompt: string,
  userPrompt: string,
  options?: {
    jsonMode?: boolean;
    maxTokens?: number;
    temperature?: number;
  }
) => Promise<{
  content: string;
  tokensUsed?: { prompt: number; completion: number };
}>;

export interface CallableProviderConfig {
  /** Name for this provider */
  name?: string;
  
  /** The completion function to call */
  complete: CompletionFunction;
  
  /** Whether to request JSON mode (default: true) */
  jsonMode?: boolean;
  
  /** Max tokens for completion */
  maxTokens?: number;
  
  /** Temperature (default: 0) */
  temperature?: number;
}

/**
 * Provider that wraps any completion function
 */
export class CallableProvider implements LLMProvider {
  readonly name: string;
  
  private config: CallableProviderConfig;

  constructor(config: CallableProviderConfig) {
    this.name = config.name ?? 'callable';
    this.config = config;
  }

  async generatePlan(request: GeneratePlanRequest): Promise<GeneratePlanResponse> {
    const result = await this.config.complete(
      request.systemPrompt,
      request.userPrompt,
      {
        jsonMode: this.config.jsonMode ?? true,
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature ?? 0,
      }
    );

    const extraction = extractDAGFromResponse(result.content, request.intent);
    if (!extraction.dag) {
      throw new Error(`Failed to extract DAG: ${extraction.error}`);
    }

    return {
      dag: extraction.dag,
      rawResponse: result.content,
      tokensUsed: result.tokensUsed,
    };
  }
}

/**
 * Create a provider from a completion function
 */
export function createCallableProvider(
  complete: CompletionFunction,
  name?: string
): CallableProvider {
  return new CallableProvider({ complete, name });
}

/**
 * Create a mock provider for testing
 * Returns a fixed DAG regardless of input
 */
export function createMockProvider(fixedResponse: string): CallableProvider {
  return new CallableProvider({
    name: 'mock',
    complete: async () => ({ content: fixedResponse }),
  });
}

/**
 * Create a provider that logs requests (useful for debugging)
 */
export function createLoggingProvider(
  inner: LLMProvider,
  log: (msg: string) => void = console.log
): LLMProvider {
  return {
    name: `logging-${inner.name}`,
    async generatePlan(request: GeneratePlanRequest): Promise<GeneratePlanResponse> {
      log(`[${inner.name}] Generating plan for: ${request.intent.goal}`);
      log(`[${inner.name}] System prompt length: ${request.systemPrompt.length}`);
      log(`[${inner.name}] User prompt length: ${request.userPrompt.length}`);
      
      const start = Date.now();
      try {
        const result = await inner.generatePlan(request);
        const duration = Date.now() - start;
        log(`[${inner.name}] Plan generated in ${duration}ms`);
        if (result.tokensUsed) {
          log(`[${inner.name}] Tokens: ${result.tokensUsed.prompt} in, ${result.tokensUsed.completion} out`);
        }
        return result;
      } catch (error) {
        const duration = Date.now() - start;
        log(`[${inner.name}] Plan generation failed after ${duration}ms: ${error}`);
        throw error;
      }
    },
  };
}

/**
 * Create a caching provider that stores plans by intent hash
 */
export function createCachingProvider(
  inner: LLMProvider,
  cache: Map<string, GeneratePlanResponse> = new Map()
): LLMProvider {
  return {
    name: `caching-${inner.name}`,
    async generatePlan(request: GeneratePlanRequest): Promise<GeneratePlanResponse> {
      // Create a cache key from the intent
      const key = JSON.stringify({
        goal: request.intent.goal,
        taskType: request.intent.taskType,
        allowedDomains: request.intent.allowedDomains.sort(),
        allowedActions: request.intent.allowedActions.sort(),
      });

      const cached = cache.get(key);
      if (cached) {
        return {
          ...cached,
          // Clone the DAG so modifications don't affect cache
          dag: JSON.parse(JSON.stringify(cached.dag)),
        };
      }

      const result = await inner.generatePlan(request);
      cache.set(key, result);
      return result;
    },
  };
}
