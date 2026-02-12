/**
 * OpenClaw Browser Guard
 * 
 * Architectural-level security for browser-using AI agents.
 * Protects web_fetch and browser tools against prompt injection attacks.
 */

// Core types
export * from './core/types.js';

// Task parsing
export { parseIntent, validateIntent } from './core/task-parser.js';

// Policy engine
export { PolicyEngine, parseSitePolicies } from './policy/engine.js';

// HTTP filter (ceLLMate-style)
export { HttpFilter, createFilterFromIntent } from './policy/http-filter.js';
export type { SitemapEntry, SitePolicy, PolicyRule, HttpRequest, FilterDecision } from './policy/http-filter.js';

// DAG building
export { buildDAG, validateDAG, describePlan, serializeDAG } from './planner/dag-builder.js';

// LLM-based planning
export {
  LLMPlanner,
  PlanGenerationError,
  DAG_SCHEMA,
  PLANNER_SYSTEM_PROMPT,
  buildPlannerPrompt,
  validateLLMResponse,
  extractDAGFromResponse,
  generatePlanWithLLM,
} from './planner/llm-planner.js';
export type {
  LLMProvider,
  LLMPlannerOptions,
  GeneratePlanRequest,
  GeneratePlanResponse,
  PlanResult,
} from './planner/llm-planner.js';

// Executor
export { SecureExecutor, MockBrowserAdapter } from './executor/runtime.js';
export type { BrowserAdapter, ExecutorConfig } from './executor/runtime.js';

// Element references with versioning (from arXiv:2511.19477)
export { 
  ElementRefManager, 
  parseRef, 
  createRef,
  isSensitiveElement,
  findSensitiveElements,
} from './executor/element-refs.js';
export type { VersionedRef, ElementSnapshot, SnapshotElement } from './executor/element-refs.js';

// Bulk actions (74% fewer calls, 57% faster - arXiv:2511.19477)
export {
  canBatchActions,
  optimizeActionSequence,
  parseBulkActions,
  serializeBulkActions,
  isFormFillingPattern,
  estimateEfficiencyGains,
} from './executor/bulk-actions.js';
export type { BulkAction, BulkActionResult, BulkExecutionResult, BulkExecutionStats } from './executor/bulk-actions.js';

// OpenClaw plugin
export { BrowserGuardPlugin, createPlugin } from './hooks/openclaw-plugin.js';
export type { BrowserGuardConfig } from './hooks/openclaw-plugin.js';

// OpenClaw Browser Adapter
export { OpenClawBrowserAdapter, createAdapterFromInvoker } from './adapters/openclaw-browser.js';
export type { OpenClawBrowserRequest, OpenClawSnapshotResponse, BrowserToolInvoker } from './adapters/openclaw-browser.js';

// Web Fetch Guard
export { WebFetchGuard, WebFetchBlockedError, createWebFetchHook } from './adapters/web-fetch-guard.js';
export type { WebFetchRequest, WebFetchGuardConfig, GuardResult } from './adapters/web-fetch-guard.js';

// Default export is the plugin creator
export { createPlugin as default } from './hooks/openclaw-plugin.js';
