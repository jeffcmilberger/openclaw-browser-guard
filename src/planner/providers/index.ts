/**
 * LLM Provider implementations for Browser Guard
 */

// OpenAI-compatible (OpenAI, Azure, local servers)
export { 
  OpenAIProvider, 
  createOpenAIProvider,
  createAzureOpenAIProvider,
} from './openai-provider.js';
export type { OpenAIProviderConfig } from './openai-provider.js';

// Anthropic Claude
export { 
  AnthropicProvider, 
  createAnthropicProvider,
} from './anthropic-provider.js';
export type { AnthropicProviderConfig } from './anthropic-provider.js';

// Generic callable (for custom integrations)
export {
  CallableProvider,
  createCallableProvider,
  createMockProvider,
  createLoggingProvider,
  createCachingProvider,
} from './callable-provider.js';
export type { CallableProviderConfig, CompletionFunction } from './callable-provider.js';
