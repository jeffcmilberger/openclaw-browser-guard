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

// Executor
export { SecureExecutor, MockBrowserAdapter } from './executor/runtime.js';
export type { BrowserAdapter, ExecutorConfig } from './executor/runtime.js';

// OpenClaw plugin
export { BrowserGuardPlugin, createPlugin } from './hooks/openclaw-plugin.js';
export type { BrowserGuardConfig } from './hooks/openclaw-plugin.js';

// Default export is the plugin creator
export { createPlugin as default } from './hooks/openclaw-plugin.js';
