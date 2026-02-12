/**
 * Adapter Tests
 * 
 * Tests for OpenClaw browser adapter and web_fetch guard
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { 
  OpenClawBrowserAdapter, 
  createAdapterFromInvoker,
} from '../dist/adapters/openclaw-browser.js';

import { 
  WebFetchGuard, 
  WebFetchBlockedError,
  createWebFetchHook,
} from '../dist/adapters/web-fetch-guard.js';

import { parseIntent } from '../dist/core/task-parser.js';

// ============================================================================
// OpenClaw Browser Adapter Tests
// ============================================================================

describe('OpenClawBrowserAdapter', () => {
  // Mock invoker that simulates OpenClaw browser responses
  function createMockInvoker() {
    let currentUrl = '';
    let currentTitle = '';
    
    return async (request: any) => {
      switch (request.action) {
        case 'navigate':
          currentUrl = request.targetUrl;
          currentTitle = 'Test Page';
          return {
            ok: true,
            url: currentUrl,
            title: currentTitle,
            targetId: 'tab-123',
          };
          
        case 'snapshot':
          return {
            ok: true,
            url: currentUrl,
            title: currentTitle,
            targetId: 'tab-123',
            snapshot: `ref=1 button "Click Me"\nref=2 textbox "Search" focusable\nref=3 link "Home"`,
          };
          
        case 'screenshot':
          return {
            ok: true,
            url: currentUrl,
            image: 'data:image/png;base64,iVBORw0KGgo=',
          };
          
        case 'act':
          return { ok: true };
          
        default:
          return { ok: false, error: 'Unknown action' };
      }
    };
  }

  describe('navigate', () => {
    it('navigates to URL and returns observation', async () => {
      const invoker = createMockInvoker();
      const adapter = createAdapterFromInvoker(invoker);
      
      const observation = await adapter.navigate('https://example.com');
      
      assert.ok(observation);
      assert.strictEqual(observation.url, 'https://example.com');
      assert.ok(observation.elements);
    });

    it('throws on navigation failure', async () => {
      const invoker = async () => ({ ok: false, error: 'Network error' });
      const adapter = createAdapterFromInvoker(invoker);
      
      await assert.rejects(
        async () => adapter.navigate('https://example.com'),
        /Navigation failed/
      );
    });
  });

  describe('click', () => {
    it('clicks element and returns updated observation', async () => {
      const invoker = createMockInvoker();
      const adapter = createAdapterFromInvoker(invoker);
      
      // Navigate first
      await adapter.navigate('https://example.com');
      
      // Then click
      const observation = await adapter.click('ref=1');
      
      assert.ok(observation);
      assert.ok(observation.url);
    });
  });

  describe('type', () => {
    it('types text into element', async () => {
      const invoker = createMockInvoker();
      const adapter = createAdapterFromInvoker(invoker);
      
      await adapter.navigate('https://example.com');
      const observation = await adapter.type('ref=2', 'hello world');
      
      assert.ok(observation);
    });
  });

  describe('getState', () => {
    it('returns current page state with parsed elements', async () => {
      const invoker = createMockInvoker();
      const adapter = createAdapterFromInvoker(invoker);
      
      await adapter.navigate('https://example.com');
      const observation = await adapter.getState();
      
      assert.ok(observation.elements);
      assert.ok(observation.elements.length >= 3);
      
      // Check parsed element structure
      const button = observation.elements.find(e => e.text === 'Click Me');
      assert.ok(button);
      assert.strictEqual(button.tagName, 'button');
    });
  });

  describe('extract', () => {
    it('extracts data from page', async () => {
      const invoker = createMockInvoker();
      const adapter = createAdapterFromInvoker(invoker);
      
      await adapter.navigate('https://example.com');
      const { observation, data } = await adapter.extract({
        buttonText: '[data-ref="1"]',
      });
      
      assert.ok(observation);
      assert.ok(data);
    });
  });

  describe('screenshot', () => {
    it('takes screenshot and returns image', async () => {
      const invoker = createMockInvoker();
      const adapter = createAdapterFromInvoker(invoker);
      
      await adapter.navigate('https://example.com');
      const { observation, image } = await adapter.screenshot();
      
      assert.ok(observation);
      assert.ok(image);
      assert.ok(image.startsWith('data:image'));
    });
  });
});

// ============================================================================
// Web Fetch Guard Tests
// ============================================================================

describe('WebFetchGuard', () => {
  describe('configuration', () => {
    it('creates guard with default config', () => {
      const guard = new WebFetchGuard();
      const config = guard.getConfig();
      
      assert.strictEqual(config.enabled, true);
      assert.strictEqual(config.mode, 'block');
    });

    it('creates guard with custom config', () => {
      const guard = new WebFetchGuard({
        mode: 'warn',
        trustedDomains: ['trusted.com'],
      });
      
      const config = guard.getConfig();
      
      assert.strictEqual(config.mode, 'warn');
      assert.ok(config.trustedDomains.includes('trusted.com'));
    });

    it('updates config', () => {
      const guard = new WebFetchGuard();
      guard.updateConfig({ mode: 'warn' });
      
      assert.strictEqual(guard.getConfig().mode, 'warn');
    });
  });

  describe('intent setting', () => {
    it('sets intent from BrowsingIntent object', () => {
      const guard = new WebFetchGuard();
      const intent = parseIntent('Check example.com');
      
      guard.setIntent(intent);
      
      // Should now allow example.com
      const result = guard.check({ url: 'https://example.com/page' });
      assert.ok(result.allowed);
    });

    it('sets intent from user request string', () => {
      const guard = new WebFetchGuard();
      const validation = guard.setIntentFromRequest('Extract from techcrunch.com');
      
      assert.ok(validation.valid);
      
      // Should allow techcrunch.com
      const result = guard.check({ url: 'https://techcrunch.com/article' });
      assert.ok(result.allowed);
    });

    it('returns validation issues for bad intent', () => {
      const guard = new WebFetchGuard();
      const intent = parseIntent('Do something');
      intent.allowedDomains = []; // Invalid
      
      // Would fail validation
    });
  });

  describe('request checking', () => {
    it('allows request to domain in intent', () => {
      const guard = new WebFetchGuard();
      guard.setIntentFromRequest('Check safe.com');
      
      const result = guard.check({
        url: 'https://safe.com/page',
        method: 'GET',
      });
      
      assert.ok(result.allowed);
    });

    it('blocks request to domain not in intent', () => {
      const guard = new WebFetchGuard();
      guard.setIntentFromRequest('Check safe.com');
      
      const result = guard.check({
        url: 'https://evil.com/malware',
        method: 'GET',
      });
      
      assert.ok(!result.allowed);
      assert.ok(result.decision.reason?.toLowerCase().includes('allowlist'));
    });

    it('allows trusted domains regardless of intent', () => {
      const guard = new WebFetchGuard({
        trustedDomains: ['always-allowed.com'],
      });
      guard.setIntentFromRequest('Check other.com');
      
      const result = guard.check({
        url: 'https://always-allowed.com/api',
        method: 'GET',
      });
      
      assert.ok(result.allowed);
      assert.ok(result.decision.reason?.includes('Trusted'));
    });

    it('warns but allows in warn mode', () => {
      const logs: string[] = [];
      const guard = new WebFetchGuard({
        mode: 'warn',
        onLog: (msg) => logs.push(msg),
      });
      guard.setIntentFromRequest('Check safe.com');
      
      const result = guard.check({
        url: 'https://blocked.com/page',
        method: 'GET',
      });
      
      // In warn mode, should allow but log warning
      assert.ok(result.allowed);
      assert.ok(logs.some(l => l.includes('WARNING')));
    });

    it('allows all when disabled', () => {
      const guard = new WebFetchGuard({ enabled: false });
      
      const result = guard.check({
        url: 'https://anything.com/anywhere',
        method: 'POST',
      });
      
      assert.ok(result.allowed);
      assert.ok(result.decision.reason?.includes('disabled'));
    });
  });

  describe('cookie stripping', () => {
    it('strips cookies when configured', () => {
      const guard = new WebFetchGuard({ stripCookies: true });
      guard.setIntentFromRequest('Extract from example.com');
      
      const result = guard.check({
        url: 'https://example.com/data',
        method: 'GET',
        headers: {
          'Cookie': 'session=abc123',
          'Authorization': 'Bearer token',
          'Accept': 'application/json',
        },
      });
      
      assert.ok(result.allowed);
      assert.ok(result.modified);
      assert.ok(!result.request.headers?.['Cookie']);
      assert.ok(!result.request.headers?.['Authorization']);
      assert.ok(result.request.headers?.['Accept']); // Non-auth headers preserved
    });
  });

  describe('guard() method', () => {
    it('returns modified request when allowed', () => {
      const guard = new WebFetchGuard();
      guard.setIntentFromRequest('Check example.com');
      
      const request = guard.guard({
        url: 'https://example.com/page',
        method: 'GET',
      });
      
      assert.ok(request);
      assert.strictEqual(request.url, 'https://example.com/page');
    });

    it('throws WebFetchBlockedError when blocked', () => {
      const guard = new WebFetchGuard();
      guard.setIntentFromRequest('Check safe.com');
      
      assert.throws(
        () => guard.guard({ url: 'https://evil.com/hack', method: 'GET' }),
        WebFetchBlockedError
      );
    });

    it('WebFetchBlockedError contains details', () => {
      const guard = new WebFetchGuard();
      guard.setIntentFromRequest('Check safe.com');
      
      try {
        guard.guard({ url: 'https://evil.com/hack', method: 'GET' });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof WebFetchBlockedError);
        assert.strictEqual(error.url, 'https://evil.com/hack');
        assert.ok(error.blockReason);
      }
    });
  });
});

describe('createWebFetchHook', () => {
  it('creates hook function', () => {
    const guard = new WebFetchGuard();
    const hook = createWebFetchHook(guard);
    
    assert.ok(typeof hook === 'function');
  });

  it('allows non-web_fetch tools through', async () => {
    const guard = new WebFetchGuard();
    const hook = createWebFetchHook(guard);
    
    const result = await hook({
      tool: 'exec',
      params: { command: 'ls' },
    });
    
    assert.ok(result.allow);
  });

  it('blocks disallowed web_fetch requests', async () => {
    const guard = new WebFetchGuard();
    guard.setIntentFromRequest('Check safe.com');
    const hook = createWebFetchHook(guard);
    
    const result = await hook({
      tool: 'web_fetch',
      params: { url: 'https://evil.com/steal' },
    });
    
    assert.ok(!result.allow);
    assert.ok(result.reason?.includes('Browser Guard'));
  });

  it('allows permitted web_fetch requests', async () => {
    const guard = new WebFetchGuard();
    guard.setIntentFromRequest('Check example.com');
    const hook = createWebFetchHook(guard);
    
    const result = await hook({
      tool: 'web_fetch',
      params: { url: 'https://example.com/page' },
    });
    
    assert.ok(result.allow);
  });

  it('sets intent from context if available', async () => {
    const guard = new WebFetchGuard();
    const hook = createWebFetchHook(guard);
    
    // First call with context should set intent
    const result = await hook({
      tool: 'web_fetch',
      params: { url: 'https://example.com/data' },
      context: { userRequest: 'Extract from example.com' },
    });
    
    assert.ok(result.allow);
  });
});
