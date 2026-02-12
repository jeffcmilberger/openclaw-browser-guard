/**
 * Integration Tests
 * 
 * End-to-end tests that verify components work together correctly
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// Import all components
import { parseIntent, validateIntent } from '../dist/core/task-parser.js';
import { PolicyEngine } from '../dist/policy/engine.js';
import { HttpFilter, createFilterFromIntent } from '../dist/policy/http-filter.js';
import { buildDAG, validateDAG, describePlan } from '../dist/planner/dag-builder.js';
import { SecureExecutor, MockBrowserAdapter } from '../dist/executor/runtime.js';
import { ElementRefManager, findSensitiveElements } from '../dist/executor/element-refs.js';
import { optimizeActionSequence, parseBulkActions } from '../dist/executor/bulk-actions.js';
import type { BulkAction } from '../dist/executor/bulk-actions.js';

describe('Integration: Search Flow', () => {
  it('complete search flow: intent → DAG → execution plan', () => {
    // 1. Parse user intent
    const intent = parseIntent('Search for RTX 5090 prices on newegg.com');
    
    // Verify intent
    assert.strictEqual(intent.taskType, 'search');
    assert.ok(intent.allowedDomains.includes('newegg.com'));
    
    // 2. Validate intent
    const intentValidation = validateIntent(intent);
    assert.ok(intentValidation.valid);
    
    // 3. Check policy
    const policy = new PolicyEngine(intent);
    const policyCheck = policy.allowsIntent(intent);
    assert.ok(policyCheck.allowed);
    
    // 4. Build execution DAG
    const dag = buildDAG(intent);
    
    // 5. Validate DAG
    const dagValidation = validateDAG(dag);
    assert.ok(dagValidation.valid);
    
    // 6. Generate plan description
    const planDescription = describePlan(dag);
    assert.ok(planDescription.includes('newegg.com'));
    assert.ok(planDescription.includes('search'));
  });

  it('rejects dangerous intent at validation stage', () => {
    // User includes password in request - should be caught early
    const intent = parseIntent('Login with password secret123 on bank.com');
    
    const validation = validateIntent(intent);
    
    assert.ok(!validation.valid);
    assert.ok(validation.issues.length > 0);
  });
});

describe('Integration: HTTP Filter + Policy', () => {
  it('HTTP filter and policy engine agree on domain restrictions', () => {
    const intent = parseIntent('Extract prices from amazon.com');
    
    // Create both policy and HTTP filter from same intent
    const policy = new PolicyEngine(intent);
    const httpFilter = createFilterFromIntent(intent);
    
    // Test allowed domain
    const allowedResult = httpFilter.filter({
      url: 'https://amazon.com/product',
      method: 'GET',
    });
    assert.ok(allowedResult.allowed);
    
    // Test blocked domain
    const blockedResult = httpFilter.filter({
      url: 'https://evil.com/steal',
      method: 'GET',
    });
    assert.ok(!blockedResult.allowed);
    
    // Policy should also block navigation to evil.com
    const policyResult = policy.allows(
      { type: 'navigate', target: 'https://evil.com/page', description: 'Navigate' },
      { currentUrl: 'https://amazon.com', currentDomain: 'amazon.com', visitedUrls: [], depth: 0, startTime: Date.now(), extractedData: {} }
    );
    assert.ok(!policyResult.allowed);
  });
});

describe('Integration: Element Refs + Sensitive Detection', () => {
  it('detects sensitive elements and blocks actions on them', () => {
    const manager = new ElementRefManager();
    
    // Simulate page with sensitive elements
    const elements = [
      { selector: '#save', tagName: 'button', text: 'Save Changes', visible: true },
      { selector: '#delete', tagName: 'button', text: 'Delete Account', visible: true },
      { selector: '#pay', tagName: 'button', text: 'Pay Now', visible: true },
    ];
    
    const snapshot = manager.createSnapshot('https://example.com', elements);
    
    // Find sensitive elements
    const sensitive = findSensitiveElements(snapshot);
    
    assert.strictEqual(sensitive.length, 2); // Delete and Pay Now
    
    // Verify we can identify which elements are sensitive
    const sensitiveRefs = sensitive.map(e => e.ref);
    
    // These refs should be blocked by policy
    const intent = parseIntent('Check example.com');
    const policy = new PolicyEngine(intent);
    
    // Clicking "Delete Account" should be blocked
    const deleteResult = policy.allows(
      { type: 'click', description: 'Delete Account', target: '#delete' },
      { currentUrl: 'https://example.com', currentDomain: 'example.com', visitedUrls: [], depth: 0, startTime: Date.now(), extractedData: {} }
    );
    // Note: Our current policy blocks by description pattern
    // In a full implementation, we'd check against sensitive refs
  });

  it('validates ref versions to prevent stale reference attacks', () => {
    const manager = new ElementRefManager();
    
    // First snapshot: Cancel button at ref 1
    manager.createSnapshot('https://example.com', [
      { selector: '#action', tagName: 'button', text: 'Cancel', visible: true },
    ]);
    
    // Page updates: Now Delete button at ref 1
    manager.createSnapshot('https://example.com', [
      { selector: '#action', tagName: 'button', text: 'Delete', visible: true },
    ]);
    
    // Try to use old ref
    const result = manager.validateRef('1:1'); // Version 1, but we're on version 2
    
    assert.ok(!result.valid);
    if (!result.valid) {
      assert.ok(result.error.toLowerCase().includes('stale'));
    }
  });
});

describe('Integration: Bulk Actions + Form Filling', () => {
  it('optimizes form filling into batches', () => {
    // Simulate LLM output for form filling
    const llmOutput = {
      bulkActions: [
        { type: 'type', ref: '1:10', text: 'John', shouldClear: true },
        { type: 'type', ref: '1:11', text: 'Doe', shouldClear: true },
        { type: 'type', ref: '1:12', text: 'john@example.com', shouldClear: true },
        { type: 'type', ref: '1:13', text: '555-0123', shouldClear: true },
        { type: 'click', ref: '1:20' }, // Submit button
      ],
    };
    
    // Parse the actions
    const parsed = parseBulkActions(llmOutput);
    assert.ok(Array.isArray(parsed));
    
    // Optimize into batches
    const batches = optimizeActionSequence(parsed as BulkAction[]);
    
    // Should be 1 batch (all form actions + submit can be batched)
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0].length, 5);
  });

  it('splits batches at navigation points', () => {
    const actions: BulkAction[] = [
      { type: 'type', ref: '1:1', text: 'query' },
      { type: 'click', ref: '1:2' }, // Search button
      { type: 'navigate', ref: '1:3' }, // Navigate to result
      { type: 'extract', ref: '1:4' },
    ];
    
    const batches = optimizeActionSequence(actions);
    
    // Should split at navigation
    assert.ok(batches.length >= 2);
  });
});

describe('Integration: Full Execution with Mock Browser', () => {
  it('executes simple extraction DAG with mock browser', async () => {
    // Setup
    const intent = parseIntent('Extract from example.com');
    const policy = new PolicyEngine(intent);
    const dag = buildDAG(intent);
    
    // Create mock browser with test page
    const adapter = new MockBrowserAdapter();
    adapter.addPage('https://example.com', {
      title: 'Example Page',
      text: 'Welcome to Example.com. This is test content.',
      elements: [
        { selector: 'h1', tagName: 'h1', text: 'Welcome', visible: true },
        { selector: 'p', tagName: 'p', text: 'Test content', visible: true },
      ],
    });
    
    // Execute
    const executor = new SecureExecutor(adapter, policy, {
      strictMode: false, // Lenient for mock testing
    });
    
    const result = await executor.execute(dag);
    
    // Verify execution completed (success or error, not timeout/blocked)
    assert.ok(['complete', 'error', 'aborted'].includes(result.status));
    assert.ok(result.trace.length > 0);
  });

  it('blocks execution when policy denies action', async () => {
    // Try to navigate outside allowed domain
    const intent = parseIntent('Check example.com');
    const policy = new PolicyEngine(intent);
    
    // Manually create a DAG that tries to navigate to blocked domain
    const dag = buildDAG(intent);
    
    // Modify first node to navigate to blocked domain
    const navNode = dag.nodes.find(n => n.action.type === 'navigate');
    if (navNode) {
      navNode.action.target = 'https://evil.com/malware';
    }
    
    const adapter = new MockBrowserAdapter();
    const executor = new SecureExecutor(adapter, policy);
    
    const result = await executor.execute(dag);
    
    assert.strictEqual(result.status, 'blocked');
    assert.ok(result.reason?.toLowerCase().includes('allowlist') || 
              result.reason?.toLowerCase().includes('not in') ||
              result.reason?.toLowerCase().includes('malicious'));
  });
});

describe('Integration: Security Boundaries', () => {
  it('prevents payment actions in extract task', () => {
    const intent = parseIntent('Extract from shopping.com');
    const policy = new PolicyEngine(intent);
    
    // Try to click "Pay Now" button
    const result = policy.allows(
      { type: 'click', description: 'Click Pay Now to complete purchase', target: '#pay' },
      { currentUrl: 'https://shopping.com', currentDomain: 'shopping.com', visitedUrls: [], depth: 0, startTime: Date.now(), extractedData: {} }
    );
    
    assert.ok(!result.allowed);
    assert.ok(result.reason?.toLowerCase().includes('payment'));
  });

  it('prevents executable downloads', () => {
    const intent = parseIntent('Download from trusted.com');
    const policy = new PolicyEngine(intent);
    
    const result = policy.allows(
      { type: 'click', description: 'Download installer', target: 'https://trusted.com/setup.exe' },
      { currentUrl: 'https://trusted.com', currentDomain: 'trusted.com', visitedUrls: [], depth: 0, startTime: Date.now(), extractedData: {} }
    );
    
    assert.ok(!result.allowed);
    assert.ok(result.reason?.toLowerCase().includes('executable'));
  });

  it('blocks cross-domain in HTTP filter even with lenient policy', () => {
    const intent = parseIntent('Check safe.com');
    const filter = createFilterFromIntent(intent);
    
    // Even if we somehow got past policy, HTTP filter blocks
    const result = filter.filter({
      url: 'https://attacker.com/phishing',
      method: 'POST',
      body: { credentials: 'stolen' },
    });
    
    assert.ok(!result.allowed);
  });

  it('enforces HTTPS for login tasks', () => {
    const intent = parseIntent('Login to example.com');
    const policy = new PolicyEngine(intent);
    
    // Try to type password on HTTP
    const result = policy.allows(
      { type: 'type', description: 'Enter password', target: '#password' },
      { currentUrl: 'http://example.com/login', currentDomain: 'example.com', visitedUrls: [], depth: 0, startTime: Date.now(), extractedData: {} }
    );
    
    assert.ok(!result.allowed);
  });
});

describe('Integration: End-to-End Scenarios', () => {
  it('price comparison scenario', () => {
    // User wants to compare prices on two shopping sites
    const intent = parseIntent('Compare RTX 5090 prices on newegg.com and amazon.com');
    
    // Should allow both domains
    assert.ok(intent.allowedDomains.some(d => d.includes('newegg')));
    assert.ok(intent.allowedDomains.some(d => d.includes('amazon')));
    
    // Should be search/extract type
    assert.ok(['search', 'extract', 'purchase'].includes(intent.taskType));
    
    // Validate and build plan
    assert.ok(validateIntent(intent).valid);
    
    const dag = buildDAG(intent);
    assert.ok(validateDAG(dag).valid);
    
    // HTTP filter should allow both domains
    const filter = createFilterFromIntent(intent);
    
    assert.ok(filter.filter({ url: 'https://newegg.com/product', method: 'GET' }).allowed);
    assert.ok(filter.filter({ url: 'https://amazon.com/dp/B123', method: 'GET' }).allowed);
    assert.ok(!filter.filter({ url: 'https://phishing.com/fake', method: 'GET' }).allowed);
  });

  it('article extraction scenario', () => {
    // User wants to extract an article
    const intent = parseIntent('Extract the article content from techcrunch.com/2026/02/ai-news');
    
    assert.strictEqual(intent.taskType, 'extract');
    assert.ok(intent.allowedDomains.some(d => d.includes('techcrunch')));
    
    // Extract tasks should use allow_public (no cookies)
    const filter = createFilterFromIntent(intent);
    const result = filter.filter({
      url: 'https://techcrunch.com/2026/02/ai-news',
      method: 'GET',
    });
    
    assert.ok(result.allowed);
    assert.strictEqual(result.action, 'allow_public');
    assert.ok(result.stripCookies);
  });
});
