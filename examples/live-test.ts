#!/usr/bin/env npx ts-node
/**
 * Live Integration Test for Browser Guard
 * 
 * Tests the guard against real websites to verify protection works.
 * Run with: npx ts-node examples/live-test.ts
 */

import {
  parseIntent,
  WebFetchGuard,
  createFilterFromIntent,
  PolicyEngine,
} from '../dist/index.js';

const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function log(color: string, prefix: string, msg: string) {
  console.log(`${color}[${prefix}]${RESET} ${msg}`);
}

async function testWebFetchGuard() {
  console.log('\n' + '='.repeat(60));
  console.log('WebFetchGuard Live Test');
  console.log('='.repeat(60) + '\n');

  const guard = new WebFetchGuard({
    mode: 'block',
    stripCookies: true,
  });

  // Test 1: Set intent and fetch allowed domain
  log(BLUE, 'TEST', 'Setting intent: "Get weather for Seattle"');
  const result1 = guard.setIntentFromRequest('Get the weather forecast from https://wttr.in for Seattle');
  log(GREEN, 'OK', `Intent parsed. Domains: ${result1.valid ? 'valid' : result1.issues.join(', ')}`);

  // Test allowed request
  log(BLUE, 'TEST', 'Checking allowed request to wttr.in...');
  const allowedResult = guard.check({ url: 'https://wttr.in/Seattle?format=3' });
  if (allowedResult.allowed) {
    log(GREEN, 'PASS', 'Request to wttr.in ALLOWED ✓');
  } else {
    log(RED, 'FAIL', `Request blocked: ${allowedResult.decision.reason}`);
  }

  // Test blocked request (attacker domain)
  log(BLUE, 'TEST', 'Checking blocked request to attacker.com...');
  const blockedResult = guard.check({ url: 'https://attacker.com/steal' });
  if (!blockedResult.allowed) {
    log(GREEN, 'PASS', `Request to attacker.com BLOCKED ✓ (${blockedResult.decision.reason})`);
  } else {
    log(RED, 'FAIL', 'Request should have been blocked!');
  }

  // Test cookie stripping
  log(BLUE, 'TEST', 'Checking cookie stripping...');
  const cookieResult = guard.check({
    url: 'https://wttr.in/Seattle',
    headers: { 'Cookie': 'session=secret123' },
  });
  if (cookieResult.allowed && cookieResult.modified && !cookieResult.request?.headers?.['Cookie']) {
    log(GREEN, 'PASS', 'Cookies stripped from request ✓');
  } else if (cookieResult.allowed) {
    log(YELLOW, 'WARN', 'Cookie stripping may not be working as expected');
  } else {
    log(RED, 'FAIL', `Request blocked: ${cookieResult.decision.reason}`);
  }
}

async function testHttpFilter() {
  console.log('\n' + '='.repeat(60));
  console.log('HTTP Filter Live Test');
  console.log('='.repeat(60) + '\n');

  // Test GitHub domain expansion
  log(BLUE, 'TEST', 'Testing GitHub domain expansion...');
  const intent = parseIntent('Check my repos on https://github.com');
  const filter = createFilterFromIntent(intent);

  const tests = [
    { url: 'https://github.com/user/repo', expected: true },
    { url: 'https://api.github.com/repos', expected: true },
    { url: 'https://raw.githubusercontent.com/file', expected: true },
    { url: 'https://github.com.evil.com/phish', expected: false },
    { url: 'https://attacker.com/steal', expected: false },
  ];

  for (const test of tests) {
    const result = filter.filter({ url: test.url, method: 'GET' });
    const pass = result.allowed === test.expected;
    if (pass) {
      log(GREEN, 'PASS', `${test.url} → ${result.allowed ? 'ALLOWED' : 'BLOCKED'} ✓`);
    } else {
      log(RED, 'FAIL', `${test.url} → expected ${test.expected ? 'ALLOWED' : 'BLOCKED'}, got ${result.allowed ? 'ALLOWED' : 'BLOCKED'}`);
    }
  }
}

async function testPolicyEngine() {
  console.log('\n' + '='.repeat(60));
  console.log('Policy Engine Live Test');
  console.log('='.repeat(60) + '\n');

  const intent = parseIntent('Browse products on https://example.com');
  const policy = new PolicyEngine(intent);

  // Test payment blocking
  log(BLUE, 'TEST', 'Testing payment action blocking...');
  const paymentAction = {
    type: 'click' as const,
    target: '#buy-btn',
    description: 'Click Pay Now button',
  };
  const context = {
    currentUrl: 'https://example.com/cart',
    currentDomain: 'example.com',
    visitedUrls: [],
    depth: 1,
    startTime: Date.now(),
    extractedData: {},
  };

  const payResult = policy.allows(paymentAction, context);
  if (!payResult.allowed) {
    log(GREEN, 'PASS', `Payment action BLOCKED ✓ (${payResult.reason})`);
  } else {
    log(RED, 'FAIL', 'Payment action should be blocked!');
  }

  // Test executable blocking
  log(BLUE, 'TEST', 'Testing executable download blocking...');
  const exeAction = {
    type: 'navigate' as const,
    target: 'https://example.com/download.exe',
    description: 'Download installer',
  };
  const exeResult = policy.allows(exeAction, context);
  if (!exeResult.allowed) {
    log(GREEN, 'PASS', `Executable download BLOCKED ✓ (${exeResult.reason})`);
  } else {
    log(RED, 'FAIL', 'Executable download should be blocked!');
  }

  // Test HTTPS for login
  log(BLUE, 'TEST', 'Testing HTTPS requirement for login...');
  const loginIntent = parseIntent('Login to https://mysite.com');
  const loginPolicy = new PolicyEngine(loginIntent);
  const httpContext = {
    currentUrl: 'http://mysite.com/login', // HTTP!
    currentDomain: 'mysite.com',
    visitedUrls: [],
    depth: 1,
    startTime: Date.now(),
    extractedData: {},
  };
  const passwordAction = {
    type: 'type' as const,
    target: 'input[type="password"]',
    value: 'secret',
    description: 'Enter password',
  };
  const httpResult = loginPolicy.allows(passwordAction, httpContext);
  if (!httpResult.allowed) {
    log(GREEN, 'PASS', `Password on HTTP BLOCKED ✓ (${httpResult.reason})`);
  } else {
    log(RED, 'FAIL', 'Password on HTTP should be blocked!');
  }
}

async function testRealFetch() {
  console.log('\n' + '='.repeat(60));
  console.log('Real Fetch Test (wttr.in)');
  console.log('='.repeat(60) + '\n');

  const guard = new WebFetchGuard({ mode: 'block' });
  guard.setIntentFromRequest('Get weather from https://wttr.in');

  const url = 'https://wttr.in/Seattle?format=3';
  log(BLUE, 'TEST', `Fetching ${url}...`);

  const check = guard.check({ url });
  if (!check.allowed) {
    log(RED, 'BLOCKED', `Guard blocked the request: ${check.decision.reason}`);
    return;
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'curl/7.0' }, // wttr.in needs this
    });
    const text = await response.text();
    log(GREEN, 'SUCCESS', `Weather: ${text.trim()}`);
  } catch (err) {
    log(RED, 'ERROR', `Fetch failed: ${err}`);
  }
}

async function main() {
  console.log('\n🛡️  Browser Guard Live Integration Tests\n');

  await testWebFetchGuard();
  await testHttpFilter();
  await testPolicyEngine();
  await testRealFetch();

  console.log('\n' + '='.repeat(60));
  console.log('All tests complete!');
  console.log('='.repeat(60) + '\n');
}

main().catch(console.error);
