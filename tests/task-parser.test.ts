/**
 * Task Parser Unit Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseIntent, validateIntent } from '../dist/core/task-parser.js';

describe('parseIntent', () => {
  describe('task type inference', () => {
    it('identifies search tasks', () => {
      const intent = parseIntent('Search for RTX 5090 prices');
      assert.strictEqual(intent.taskType, 'search');
    });

    it('identifies search with "find"', () => {
      const intent = parseIntent('Find the best restaurants nearby');
      assert.strictEqual(intent.taskType, 'search');
    });

    it('identifies search with "look up"', () => {
      const intent = parseIntent('Look up the weather in NYC');
      assert.strictEqual(intent.taskType, 'search');
    });

    it('identifies purchase tasks', () => {
      const intent = parseIntent('Buy a new keyboard on Amazon');
      assert.strictEqual(intent.taskType, 'purchase');
    });

    it('identifies extract tasks', () => {
      const intent = parseIntent('Extract the article text from this page');
      assert.strictEqual(intent.taskType, 'extract');
    });

    it('identifies login tasks', () => {
      const intent = parseIntent('Log in to my GitHub account');
      assert.strictEqual(intent.taskType, 'login');
    });

    it('identifies monitor tasks', () => {
      const intent = parseIntent('Monitor this page for changes');
      assert.strictEqual(intent.taskType, 'monitor');
    });

    it('defaults to extract for unknown tasks', () => {
      const intent = parseIntent('Do something with this website');
      assert.strictEqual(intent.taskType, 'extract');
    });
  });

  describe('domain extraction', () => {
    it('extracts domain from full URL', () => {
      const intent = parseIntent('Check https://example.com/page');
      assert.ok(intent.allowedDomains.includes('example.com'));
    });

    it('extracts domain mentions', () => {
      const intent = parseIntent('Search on newegg.com for GPUs');
      assert.ok(intent.allowedDomains.includes('newegg.com'));
    });

    it('adds www variants automatically', () => {
      const intent = parseIntent('Check example.com');
      assert.ok(intent.allowedDomains.includes('example.com'));
      assert.ok(intent.allowedDomains.includes('www.example.com'));
    });

    it('adds GitHub-related domains for github.com', () => {
      const intent = parseIntent('Check my repos on github.com');
      assert.ok(intent.allowedDomains.includes('github.com'));
      assert.ok(intent.allowedDomains.includes('raw.githubusercontent.com'));
      assert.ok(intent.allowedDomains.includes('api.github.com'));
    });

    it('defaults to google.com when no domain specified', () => {
      const intent = parseIntent('Search for something');
      assert.ok(intent.allowedDomains.some(d => d.includes('google.com')));
    });

    it('extracts multiple domains', () => {
      const intent = parseIntent('Compare prices on amazon.com and newegg.com');
      assert.ok(intent.allowedDomains.includes('amazon.com'));
      assert.ok(intent.allowedDomains.includes('newegg.com'));
    });
  });

  describe('sensitive data detection', () => {
    it('detects password mentions', () => {
      const intent = parseIntent('Login with password abc123');
      assert.ok(intent.sensitiveData.includes('password'));
    });

    it('detects email patterns', () => {
      const intent = parseIntent('Send to user@example.com');
      assert.ok(intent.sensitiveData.includes('email'));
    });

    it('detects API key mentions', () => {
      const intent = parseIntent('Use my api_key to authenticate');
      assert.ok(intent.sensitiveData.includes('api_key'));
    });

    it('detects secret mentions', () => {
      const intent = parseIntent('Enter the secret code');
      assert.ok(intent.sensitiveData.includes('secret'));
    });

    it('returns empty array when no sensitive data', () => {
      const intent = parseIntent('Search for cats');
      assert.strictEqual(intent.sensitiveData.length, 0);
    });
  });

  describe('action permissions', () => {
    it('search tasks allow navigate, type, click, scroll, extract', () => {
      const intent = parseIntent('Search for something');
      assert.ok(intent.allowedActions.includes('navigate'));
      assert.ok(intent.allowedActions.includes('type'));
      assert.ok(intent.allowedActions.includes('click'));
      assert.ok(intent.allowedActions.includes('scroll'));
      assert.ok(intent.allowedActions.includes('extract'));
    });

    it('extract tasks do not allow type', () => {
      const intent = parseIntent('Extract data from example.com');
      assert.ok(intent.allowedActions.includes('extract'));
      assert.ok(!intent.allowedActions.includes('type'));
    });

    it('login tasks allow type but are limited', () => {
      const intent = parseIntent('Log in to example.com');
      assert.ok(intent.allowedActions.includes('type'));
      assert.ok(intent.allowedActions.includes('click'));
      assert.ok(!intent.allowedActions.includes('scroll'));
    });
  });

  describe('constraints', () => {
    it('sets default maxDepth based on task type', () => {
      const searchIntent = parseIntent('Search for cats');
      const extractIntent = parseIntent('Extract from example.com');
      
      assert.strictEqual(searchIntent.maxDepth, 3);
      assert.strictEqual(extractIntent.maxDepth, 5);
    });

    it('allows override of maxDepth', () => {
      const intent = parseIntent('Search for cats', { maxDepth: 10 });
      assert.strictEqual(intent.maxDepth, 10);
    });

    it('sets default timeout based on task type', () => {
      const searchIntent = parseIntent('Search for cats');
      assert.strictEqual(searchIntent.timeout, 30000);
    });

    it('allows override of timeout', () => {
      const intent = parseIntent('Search for cats', { timeout: 60000 });
      assert.strictEqual(intent.timeout, 60000);
    });
  });

  describe('goal summarization', () => {
    it('preserves short goals', () => {
      const intent = parseIntent('Search for cats');
      assert.strictEqual(intent.goal, 'Search for cats');
    });

    it('truncates very long goals', () => {
      const longRequest = 'Search for ' + 'very '.repeat(50) + 'long query';
      const intent = parseIntent(longRequest);
      assert.ok(intent.goal.length <= 103); // 100 + "..."
      assert.ok(intent.goal.endsWith('...'));
    });

    it('stores original request', () => {
      const request = 'Search for cats on google.com';
      const intent = parseIntent(request);
      assert.strictEqual(intent.originalRequest, request);
    });
  });
});

describe('validateIntent', () => {
  it('validates clean search intent', () => {
    const intent = parseIntent('Search for cats on google.com');
    const result = validateIntent(intent);
    
    assert.ok(result.valid);
    assert.strictEqual(result.issues.length, 0);
  });

  it('rejects login task with password in request', () => {
    const intent = parseIntent('Login with password secret123 on example.com');
    const result = validateIntent(intent);
    
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.toLowerCase().includes('password')));
  });

  it('rejects purchase task with credit card in request', () => {
    const intent = parseIntent('Buy with card 1234567890123456 on amazon.com');
    const result = validateIntent(intent);
    
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.toLowerCase().includes('credit card')));
  });

  it('warns about excessive timeout', () => {
    const intent = parseIntent('Check example.com', { timeout: 600000 });
    const result = validateIntent(intent);
    
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.includes('5 minutes')));
  });

  it('rejects intent with no domains', () => {
    const intent = parseIntent('Do something');
    // Manually clear domains to test validation
    intent.allowedDomains = [];
    const result = validateIntent(intent);
    
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.toLowerCase().includes('no domains')));
  });

  it('rejects overly broad domain patterns', () => {
    const intent = parseIntent('Search on google.com');
    intent.allowedDomains = ['*'];
    const result = validateIntent(intent);
    
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.toLowerCase().includes('broad')));
  });
});
