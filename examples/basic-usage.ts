/**
 * Browser Guard - Basic Usage Examples
 * 
 * This file demonstrates how to integrate Browser Guard with OpenClaw.
 */

// =============================================================================
// Example 1: Protecting web_fetch with WebFetchGuard
// =============================================================================

import { WebFetchGuard, createWebFetchHook } from '../src/index.js';

// Create a guard instance
const webFetchGuard = new WebFetchGuard({
  mode: 'block',           // 'warn' to log but allow, 'block' to prevent
  stripCookies: true,      // Remove auth cookies for privacy
  trustedDomains: [        // Always allow these domains
    'api.openai.com',
    'api.anthropic.com',
  ],
  onLog: console.log,      // Debug logging
});

// Set intent from user's request
webFetchGuard.setIntentFromRequest('Search for AI news on techcrunch.com');

// Now check requests
const result = webFetchGuard.check({
  url: 'https://techcrunch.com/category/ai',
  method: 'GET',
});

console.log('Allowed:', result.allowed);
console.log('Decision:', result.decision);

// Or use guard() which throws on block
try {
  const safeRequest = webFetchGuard.guard({
    url: 'https://evil.com/malware',
    method: 'GET',
  });
} catch (error) {
  console.log('Blocked:', error.message);
}


// =============================================================================
// Example 2: OpenClaw Plugin Hook
// =============================================================================

/*
// In your OpenClaw plugin:

import { createWebFetchHook, WebFetchGuard } from 'openclaw-browser-guard';

const guard = new WebFetchGuard({ mode: 'block' });

export const plugin = {
  name: 'browser-guard',
  
  hooks: {
    async before_tool_call(call) {
      // Set intent from conversation context
      if (call.context?.userRequest) {
        guard.setIntentFromRequest(call.context.userRequest);
      }
      
      // Check web_fetch calls
      if (call.tool === 'web_fetch') {
        const hook = createWebFetchHook(guard);
        return hook(call);
      }
      
      return { allow: true };
    }
  }
};
*/


// =============================================================================
// Example 3: Full Flow with DAG Execution
// =============================================================================

import { 
  parseIntent, 
  validateIntent,
  PolicyEngine,
  buildDAG,
  validateDAG,
  describePlan,
  SecureExecutor,
  MockBrowserAdapter,
} from '../src/index.js';

async function secureSearchFlow(userRequest: string) {
  // 1. Parse user intent
  console.log('\n=== Step 1: Parse Intent ===');
  const intent = parseIntent(userRequest);
  console.log('Task type:', intent.taskType);
  console.log('Allowed domains:', intent.allowedDomains);
  
  // 2. Validate intent
  console.log('\n=== Step 2: Validate Intent ===');
  const validation = validateIntent(intent);
  if (!validation.valid) {
    console.error('Invalid intent:', validation.issues);
    return;
  }
  console.log('Intent valid ✓');
  
  // 3. Create policy engine
  console.log('\n=== Step 3: Check Policy ===');
  const policy = new PolicyEngine(intent);
  const policyCheck = policy.allowsIntent(intent);
  if (!policyCheck.allowed) {
    console.error('Policy denied:', policyCheck.reason);
    return;
  }
  console.log('Policy allows intent ✓');
  
  // 4. Build execution DAG
  console.log('\n=== Step 4: Build Execution Plan ===');
  const dag = buildDAG(intent);
  const dagValidation = validateDAG(dag);
  if (!dagValidation.valid) {
    console.error('Invalid DAG:', dagValidation.issues);
    return;
  }
  console.log('DAG valid ✓');
  console.log('Nodes:', dag.nodes.length);
  console.log('Edges:', dag.edges.length);
  
  // 5. Show plan to user
  console.log('\n=== Execution Plan ===');
  console.log(describePlan(dag));
  
  // 6. Execute with mock browser
  console.log('\n=== Step 5: Execute ===');
  const adapter = new MockBrowserAdapter();
  adapter.addPage('https://example.com', {
    title: 'Example Search Results',
    text: 'Found 10 results for your query',
    elements: [
      { selector: 'input[name="q"]', tagName: 'input', visible: true },
      { selector: '.result', tagName: 'div', text: 'Result 1', visible: true },
    ],
  });
  
  const executor = new SecureExecutor(adapter, policy, {
    strictMode: false,
    onStep: (node) => console.log(`  → ${node.action.description}`),
  });
  
  const result = await executor.execute(dag);
  
  console.log('\n=== Result ===');
  console.log('Status:', result.status);
  console.log('Duration:', result.duration, 'ms');
  if (result.data) {
    console.log('Extracted data:', result.data);
  }
  if (result.reason) {
    console.log('Reason:', result.reason);
  }
}

// Run example
secureSearchFlow('Search for cats on example.com');


// =============================================================================
// Example 4: Sensitive Element Detection
// =============================================================================

import { 
  ElementRefManager, 
  findSensitiveElements,
  isSensitiveElement,
} from '../src/index.js';

function detectDangerousButtons() {
  console.log('\n=== Sensitive Element Detection ===');
  
  const manager = new ElementRefManager();
  
  // Simulate page with various buttons
  const snapshot = manager.createSnapshot('https://bank.com/account', [
    { selector: '#view', tagName: 'button', text: 'View Balance', visible: true },
    { selector: '#transfer', tagName: 'button', text: 'Transfer Funds', visible: true },
    { selector: '#delete', tagName: 'button', text: 'Delete Account', visible: true },
    { selector: '#logout', tagName: 'button', text: 'Log Out', visible: true },
  ]);
  
  // Find all sensitive elements
  const sensitive = findSensitiveElements(snapshot);
  
  console.log('Found', sensitive.length, 'sensitive elements:');
  for (const elem of sensitive) {
    console.log(`  - "${elem.text}" (ref=${elem.ref})`);
  }
  
  // These refs should be blocked or require confirmation
}

detectDangerousButtons();


// =============================================================================
// Example 5: Bulk Action Optimization
// =============================================================================

import { 
  parseBulkActions, 
  optimizeActionSequence,
  estimateEfficiencyGains,
} from '../src/index.js';

function optimizeFormFilling() {
  console.log('\n=== Bulk Action Optimization ===');
  
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
  
  // Parse actions
  const actions = parseBulkActions(llmOutput);
  if (!Array.isArray(actions)) {
    console.error('Parse error:', actions.error);
    return;
  }
  
  console.log('Parsed', actions.length, 'actions');
  
  // Optimize into batches
  const batches = optimizeActionSequence(actions);
  console.log('Optimized into', batches.length, 'batch(es)');
  
  // Estimate savings
  const stats = estimateEfficiencyGains(actions.length, batches.length);
  console.log('Estimated time saved:', Math.round(stats.estimatedTimeSaved / 1000), 'seconds');
  console.log('Estimated tokens saved:', stats.estimatedTokensSaved);
}

optimizeFormFilling();
