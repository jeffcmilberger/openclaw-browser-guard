/**
 * OpenAI-compatible LLM Provider for Browser Guard
 * 
 * Works with any OpenAI-compatible API (OpenAI, Azure OpenAI, local servers).
 * Uses JSON mode for structured output.
 */

import type { BrowsingIntent, ExecutionDAG } from '../../core/types.js';
import type { LLMProvider, GeneratePlanRequest, GeneratePlanResponse } from '../llm-planner.js';
import { extractDAGFromResponse } from '../llm-planner.js';

export interface OpenAIProviderConfig {
  /** API key for authentication */
  apiKey: string;
  
  /** Base URL for API (default: https://api.openai.com/v1) */
  baseUrl?: string;
  
  /** Model to use (default: gpt-4o) */
  model?: string;
  
  /** Maximum tokens for completion */
  maxTokens?: number;
  
  /** Temperature for sampling (default: 0 for deterministic) */
  temperature?: number;
  
  /** Request timeout in ms (default: 60000) */
  timeout?: number;
  
  /** Additional headers to include */
  headers?: Record<string, string>;
}

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIChatResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI-compatible provider for DAG generation
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  
  private config: Required<OpenAIProviderConfig>;

  constructor(config: OpenAIProviderConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
      model: config.model ?? 'gpt-4o',
      maxTokens: config.maxTokens ?? 4096,
      temperature: config.temperature ?? 0,
      timeout: config.timeout ?? 60000,
      headers: config.headers ?? {},
    };
  }

  async generatePlan(request: GeneratePlanRequest): Promise<GeneratePlanResponse> {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ];

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
          ...this.config.headers,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          max_tokens: this.config.maxTokens,
          temperature: this.config.temperature,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenAI API error (${response.status}): ${error}`);
      }

      const data = await response.json() as OpenAIChatResponse;
      const content = data.choices[0]?.message?.content ?? '';

      // Extract DAG from response
      const extraction = extractDAGFromResponse(content, request.intent);
      if (!extraction.dag) {
        throw new Error(`Failed to extract DAG: ${extraction.error}`);
      }

      return {
        dag: extraction.dag,
        rawResponse: content,
        tokensUsed: data.usage ? {
          prompt: data.usage.prompt_tokens,
          completion: data.usage.completion_tokens,
        } : undefined,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Create an OpenAI provider with minimal config
 */
export function createOpenAIProvider(apiKey: string, model?: string): OpenAIProvider {
  return new OpenAIProvider({ apiKey, model });
}

/**
 * Create an Azure OpenAI provider
 */
export function createAzureOpenAIProvider(
  endpoint: string,
  apiKey: string,
  deploymentName: string,
  apiVersion: string = '2024-02-15-preview'
): OpenAIProvider {
  return new OpenAIProvider({
    apiKey,
    baseUrl: `${endpoint}/openai/deployments/${deploymentName}`,
    model: deploymentName,
    headers: {
      'api-key': apiKey,
    },
  });
}
