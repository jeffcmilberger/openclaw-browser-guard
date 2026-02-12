/**
 * Anthropic Claude Provider for Browser Guard
 * 
 * Uses Claude's tool use feature with a schema-following tool
 * to get structured DAG output.
 */

import type { LLMProvider, GeneratePlanRequest, GeneratePlanResponse } from '../llm-planner.js';
import { extractDAGFromResponse, DAG_SCHEMA } from '../llm-planner.js';

export interface AnthropicProviderConfig {
  /** API key for authentication */
  apiKey: string;
  
  /** Model to use (default: claude-sonnet-4-20250514) */
  model?: string;
  
  /** Maximum tokens for completion */
  maxTokens?: number;
  
  /** Request timeout in ms (default: 120000 - Claude can be slower) */
  timeout?: number;
  
  /** Beta headers to enable (e.g., prompt caching) */
  betaFeatures?: string[];
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: object;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Anthropic Claude provider for DAG generation
 * Uses tool use to enforce structured output
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  
  private config: Required<AnthropicProviderConfig>;

  constructor(config: AnthropicProviderConfig) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model ?? 'claude-sonnet-4-20250514',
      maxTokens: config.maxTokens ?? 4096,
      timeout: config.timeout ?? 120000,
      betaFeatures: config.betaFeatures ?? [],
    };
  }

  async generatePlan(request: GeneratePlanRequest): Promise<GeneratePlanResponse> {
    // Define a tool that accepts our DAG schema
    const dagTool: AnthropicTool = {
      name: 'submit_execution_plan',
      description: 'Submit the complete execution DAG for the browsing task. Call this tool with the plan once you have enumerated all branches.',
      input_schema: {
        type: 'object',
        properties: {
          ...DAG_SCHEMA.properties,
          reasoning: {
            type: 'string',
            description: 'Brief explanation of the plan structure and branch enumeration',
          },
        },
        required: [...DAG_SCHEMA.required, 'reasoning'],
      },
    };

    const messages: AnthropicMessage[] = [
      { role: 'user', content: request.userPrompt },
    ];

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      };

      if (this.config.betaFeatures.length > 0) {
        headers['anthropic-beta'] = this.config.betaFeatures.join(',');
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          system: request.systemPrompt,
          messages,
          tools: [dagTool],
          tool_choice: { type: 'tool', name: 'submit_execution_plan' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Anthropic API error (${response.status}): ${error}`);
      }

      const data = await response.json() as AnthropicResponse;
      
      // Find the tool use block
      const toolUse = data.content.find(block => block.type === 'tool_use');
      if (!toolUse || !toolUse.input) {
        throw new Error('No tool use found in response');
      }

      const input = toolUse.input as { nodes?: unknown[]; edges?: unknown[]; entryPoint?: string; reasoning?: string };
      const rawResponse = JSON.stringify(input);

      // Extract DAG from the tool input
      const extraction = extractDAGFromResponse(rawResponse, request.intent);
      if (!extraction.dag) {
        throw new Error(`Failed to extract DAG: ${extraction.error}`);
      }

      return {
        dag: extraction.dag,
        rawResponse,
        tokensUsed: {
          prompt: data.usage.input_tokens,
          completion: data.usage.output_tokens,
        },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Create an Anthropic provider with minimal config
 */
export function createAnthropicProvider(apiKey: string, model?: string): AnthropicProvider {
  return new AnthropicProvider({ apiKey, model });
}
