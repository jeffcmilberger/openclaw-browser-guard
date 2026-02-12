/**
 * Task Parser Tests
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseIntent, validateIntent } from '../src/core/task-parser.js';

describe('parseIntent', () => {
  test('parses search intent', () => {
    const intent = parseIntent('Search for RTX 5090 prices on newegg.com');
    
    assert.strictEqual(intent.taskType, 'search');
    assert.ok(intent.allowedDomains.includes('newegg.com'));
    assert.ok(intent.allowedActions.includes('navigate'));
    assert.ok(intent.allowedActions.includes('extract'));
  });
  
  test('parses extract intent', () => {
    const intent = parseIntent('Extract the article text from https://example.com/article');
    
    assert.strictEqual(intent.taskType, 'extract');
    assert.ok(intent.allowedDomains.includes('example.com'));
  });
  
  test('detects sensitive data', () => {
    const intent = parseIntent('Log in with password abc123');
    
    assert.ok(intent.sensitiveData.includes('password'));
    assert.strictEqual(intent.taskType, 'login');
  });
  
  test('defaults to extract for unknown tasks', () => {
    const intent = parseIntent('Do something with website.com');
    
    assert.strictEqual(intent.taskType, 'extract');
    assert.ok(intent.allowedDomains.includes('website.com'));
  });
  
  test('adds www variants automatically', () => {
    const intent = parseIntent('Check example.com');
    
    assert.ok(intent.allowedDomains.includes('example.com'));
    assert.ok(intent.allowedDomains.includes('www.example.com'));
  });
});

describe('validateIntent', () => {
  test('validates clean intent', () => {
    const intent = parseIntent('Search for cats on google.com');
    const result = validateIntent(intent);
    
    assert.ok(result.valid);
    assert.strictEqual(result.issues.length, 0);
  });
  
  test('rejects password in login request', () => {
    const intent = parseIntent('Login with password secret123 on example.com');
    const result = validateIntent(intent);
    
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.includes('password')));
  });
  
  test('warns about excessive timeout', () => {
    const intent = parseIntent('Check example.com', { timeout: 600000 });
    const result = validateIntent(intent);
    
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.includes('5 minutes')));
  });
});
