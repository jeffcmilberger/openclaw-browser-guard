/**
 * Policy Engine Unit Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PolicyEngine, parseSitePolicies } from '../dist/policy/engine.js';
import { parseIntent } from '../dist/core/task-parser.js';
import type { BrowserAction, ExecutionContext } from '../dist/core/types.js';

// Helper to create a mock execution context
function createContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    currentUrl: 'https://example.com',
    currentDomain: 'example.com',
    visitedUrls: ['https://example.com'],
    depth: 1,
    startTime: Date.now(),
    extractedData: {},
    ...overrides,
  };
}

// Helper to create a browser action
function createAction(overrides: Partial<BrowserAction> = {}): BrowserAction {
  return {
    type: 'click',
    description: 'Click a button',
    ...overrides,
  };
}

describe('PolicyEngine', () => {
  describe('constructor', () => {
    it('creates policy engine without intent', () => {
      const engine = new PolicyEngine();
      assert.ok(engine);
      assert.ok(engine.getRules().length > 0); // Should have static rules
    });

    it('creates policy engine with intent', () => {
      const intent = parseIntent('Search on example.com');
      const engine = new PolicyEngine(intent);
      assert.ok(engine);
      
      // Should have both static and task-derived rules
      const rules = engine.getRules();
      assert.ok(rules.some(r => r.source === 'static'));
      assert.ok(rules.some(r => r.source === 'task'));
    });
  });

  describe('allowsIntent', () => {
    it('allows clean search intent', () => {
      const intent = parseIntent('Search for cats on google.com');
      const engine = new PolicyEngine();
      const result = engine.allowsIntent(intent);
      
      assert.ok(result.allowed);
      assert.strictEqual(result.effect, 'allow');
    });

    it('denies intent with malicious domain patterns', () => {
      const intent = parseIntent('Check phishing.example.com');
      intent.allowedDomains = ['phishing.example.com'];
      const engine = new PolicyEngine();
      const result = engine.allowsIntent(intent);
      
      assert.ok(!result.allowed);
      assert.strictEqual(result.effect, 'deny');
      assert.ok(result.reason?.toLowerCase().includes('malicious'));
    });
  });

  describe('allows (action checking)', () => {
    describe('executable downloads', () => {
      it('blocks .exe downloads', () => {
        const engine = new PolicyEngine();
        const action = createAction({
          type: 'click',
          target: 'https://example.com/malware.exe',
          description: 'Download file',
        });
        const context = createContext();
        
        const result = engine.allows(action, context);
        assert.ok(!result.allowed);
        assert.ok(result.reason?.toLowerCase().includes('executable'));
      });

      it('blocks .msi downloads', () => {
        const engine = new PolicyEngine();
        const action = createAction({
          type: 'navigate',
          target: 'https://example.com/installer.msi',
          description: 'Download installer',
        });
        const context = createContext();
        
        const result = engine.allows(action, context);
        assert.ok(!result.allowed);
      });

      it('allows normal file downloads', () => {
        const engine = new PolicyEngine();
        const action = createAction({
          type: 'click',
          target: 'https://example.com/document.pdf',
          description: 'Download PDF',
        });
        const context = createContext();
        
        const result = engine.allows(action, context);
        assert.ok(result.allowed);
      });
    });

    describe('payment detection', () => {
      it('blocks "pay now" buttons', () => {
        const engine = new PolicyEngine();
        const action = createAction({
          type: 'click',
          description: 'Click Pay Now button',
        });
        const context = createContext();
        
        const result = engine.allows(action, context);
        assert.ok(!result.allowed);
        assert.ok(result.reason?.toLowerCase().includes('payment'));
      });

      it('blocks "place order" buttons', () => {
        const engine = new PolicyEngine();
        const action = createAction({
          type: 'click',
          description: 'Place Order',
        });
        const context = createContext();
        
        const result = engine.allows(action, context);
        assert.ok(!result.allowed);
      });

      it('blocks checkout buttons', () => {
        const engine = new PolicyEngine();
        const action = createAction({
          type: 'click',
          description: 'Proceed to Checkout',
        });
        const context = createContext();
        
        const result = engine.allows(action, context);
        assert.ok(!result.allowed);
      });

      it('allows normal buttons', () => {
        const engine = new PolicyEngine();
        const action = createAction({
          type: 'click',
          description: 'Add to Cart',
        });
        const context = createContext();
        
        const result = engine.allows(action, context);
        assert.ok(result.allowed);
      });
    });

    describe('HTTPS for login', () => {
      it('blocks login actions on HTTP', () => {
        const intent = parseIntent('Log in to example.com');
        const engine = new PolicyEngine(intent);
        const action = createAction({
          type: 'type',
          description: 'Enter password',
        });
        const context = createContext({
          currentUrl: 'http://example.com/login', // HTTP, not HTTPS
        });
        
        const result = engine.allows(action, context);
        assert.ok(!result.allowed);
        assert.ok(result.reason?.toLowerCase().includes('https') || 
                  result.reason?.toLowerCase().includes('credentials'));
      });

      it('allows login actions on HTTPS', () => {
        const intent = parseIntent('Log in to example.com');
        const engine = new PolicyEngine(intent);
        const action = createAction({
          type: 'type',
          description: 'Enter username',
        });
        const context = createContext({
          currentUrl: 'https://example.com/login',
        });
        
        const result = engine.allows(action, context);
        assert.ok(result.allowed);
      });
    });

    describe('domain allowlist', () => {
      it('allows navigation to allowed domain', () => {
        const intent = parseIntent('Check example.com');
        const engine = new PolicyEngine(intent);
        const action = createAction({
          type: 'navigate',
          target: 'https://example.com/page',
          description: 'Navigate to page',
        });
        const context = createContext();
        
        const result = engine.allows(action, context);
        assert.ok(result.allowed);
      });

      it('blocks navigation to disallowed domain', () => {
        const intent = parseIntent('Check example.com');
        const engine = new PolicyEngine(intent);
        const action = createAction({
          type: 'navigate',
          target: 'https://evil.com/page',
          description: 'Navigate to page',
        });
        const context = createContext();
        
        const result = engine.allows(action, context);
        assert.ok(!result.allowed);
        assert.ok(result.reason?.toLowerCase().includes('allowlist') ||
                  result.reason?.toLowerCase().includes('not in'));
      });

      it('allows subdomain of allowed domain', () => {
        const intent = parseIntent('Check example.com');
        const engine = new PolicyEngine(intent);
        const action = createAction({
          type: 'navigate',
          target: 'https://api.example.com/data',
          description: 'Navigate to API',
        });
        const context = createContext();
        
        const result = engine.allows(action, context);
        assert.ok(result.allowed);
      });
    });

    describe('action allowlist', () => {
      it('blocks disallowed action types', () => {
        const intent = parseIntent('Extract data from example.com');
        // Extract tasks don't allow 'type'
        const engine = new PolicyEngine(intent);
        const action = createAction({
          type: 'type',
          target: 'input',
          value: 'test',
          description: 'Type into input',
        });
        const context = createContext();
        
        const result = engine.allows(action, context);
        assert.ok(!result.allowed);
        assert.ok(result.reason?.toLowerCase().includes('not allowed'));
      });
    });
  });

  describe('getRules', () => {
    it('returns copy of rules array', () => {
      const engine = new PolicyEngine();
      const rules1 = engine.getRules();
      const rules2 = engine.getRules();
      
      assert.notStrictEqual(rules1, rules2); // Different array instances
      assert.deepStrictEqual(rules1, rules2); // Same content
    });

    it('includes static rules', () => {
      const engine = new PolicyEngine();
      const rules = engine.getRules();
      
      assert.ok(rules.some(r => r.id.startsWith('static:')));
    });

    it('includes task-derived rules when intent provided', () => {
      const intent = parseIntent('Search on example.com');
      const engine = new PolicyEngine(intent);
      const rules = engine.getRules();
      
      assert.ok(rules.some(r => r.id.startsWith('task:')));
    });
  });
});

describe('parseSitePolicies', () => {
  it('parses no-form-submit directive', () => {
    const html = '<meta name="ai-agent-policy" content="no-form-submit">';
    const policies = parseSitePolicies(html, 'example.com');
    
    assert.strictEqual(policies.length, 1);
    assert.strictEqual(policies[0].effect, 'deny');
    assert.ok(policies[0].description.includes('form submission'));
  });

  it('parses read-only directive', () => {
    const html = '<meta name="ai-agent-policy" content="read-only">';
    const policies = parseSitePolicies(html, 'example.com');
    
    assert.strictEqual(policies.length, 1);
    assert.strictEqual(policies[0].effect, 'deny');
    assert.ok(policies[0].scope.actions?.includes('click'));
    assert.ok(policies[0].scope.actions?.includes('type'));
  });

  it('parses no-ai-agents directive', () => {
    const html = '<meta name="ai-agent-policy" content="no-ai-agents">';
    const policies = parseSitePolicies(html, 'example.com');
    
    assert.strictEqual(policies.length, 1);
    assert.strictEqual(policies[0].effect, 'deny');
    assert.strictEqual(policies[0].priority, 1); // High priority
  });

  it('parses multiple directives', () => {
    const html = '<meta name="ai-agent-policy" content="no-form-submit, read-only">';
    const policies = parseSitePolicies(html, 'example.com');
    
    assert.strictEqual(policies.length, 2);
  });

  it('returns empty array when no meta tag', () => {
    const html = '<html><head><title>Test</title></head></html>';
    const policies = parseSitePolicies(html, 'example.com');
    
    assert.strictEqual(policies.length, 0);
  });

  it('handles double quotes in meta tag', () => {
    const html = '<meta name="ai-agent-policy" content="no-form-submit">';
    const policies = parseSitePolicies(html, 'example.com');
    
    assert.strictEqual(policies.length, 1);
  });

  it('handles single quotes in meta tag', () => {
    const html = "<meta name='ai-agent-policy' content='no-form-submit'>";
    const policies = parseSitePolicies(html, 'example.com');
    
    assert.strictEqual(policies.length, 1);
  });
});
