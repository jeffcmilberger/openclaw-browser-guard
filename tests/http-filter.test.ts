/**
 * HTTP Filter Unit Tests
 * 
 * Tests for ceLLMate-style HTTP request filtering
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { HttpFilter, createFilterFromIntent } from '../dist/policy/http-filter.js';
import { parseIntent } from '../dist/core/task-parser.js';
import type { SitemapEntry, SitePolicy, HttpRequest } from '../dist/policy/http-filter.js';

describe('HttpFilter', () => {
  describe('basic filtering', () => {
    it('creates filter instance', () => {
      const filter = new HttpFilter();
      assert.ok(filter);
    });

    it('blocks requests when predicted allowlist is active and domain not in list', () => {
      const filter = new HttpFilter();
      filter.setPredictedAllowlist(['example.com'], true);
      
      const request: HttpRequest = {
        url: 'https://evil.com/page',
        method: 'GET',
      };
      
      const result = filter.filter(request);
      
      assert.ok(!result.allowed);
      assert.strictEqual(result.action, 'deny');
      assert.ok(result.reason?.toLowerCase().includes('allowlist'));
    });

    it('allows requests when domain is in predicted allowlist', () => {
      const filter = new HttpFilter();
      filter.setPredictedAllowlist(['example.com'], true);
      filter.loadPolicy('example.com', {
        name: 'test',
        description: 'Test policy',
        default: 'allow',
        domains: ['example.com'],
        allowed_domains: ['example.com'],
        allowed_requests: [],
        rules: [],
      });
      
      const request: HttpRequest = {
        url: 'https://example.com/page',
        method: 'GET',
      };
      
      const result = filter.filter(request);
      
      assert.ok(result.allowed);
    });

    it('allows requests when allowlist is inactive', () => {
      const filter = new HttpFilter();
      filter.setPredictedAllowlist(['example.com'], false); // Inactive
      filter.loadPolicy('other.com', {
        name: 'test',
        description: 'Test policy',
        default: 'allow',
        domains: ['other.com'],
        allowed_domains: ['other.com'],
        allowed_requests: [],
        rules: [],
      });
      
      const request: HttpRequest = {
        url: 'https://other.com/page',
        method: 'GET',
      };
      
      const result = filter.filter(request);
      
      assert.ok(result.allowed);
    });
  });

  describe('policy enforcement', () => {
    it('blocks requests to domains without policy', () => {
      const filter = new HttpFilter();
      
      const request: HttpRequest = {
        url: 'https://unknown.com/page',
        method: 'GET',
      };
      
      const result = filter.filter(request);
      
      assert.ok(!result.allowed);
      assert.ok(result.reason?.toLowerCase().includes('no policy'));
    });

    it('uses default policy action', () => {
      const filter = new HttpFilter();
      filter.loadPolicy('example.com', {
        name: 'test',
        description: 'Test policy',
        default: 'allow_public',
        domains: ['example.com'],
        allowed_domains: ['example.com'],
        allowed_requests: [],
        rules: [],
      });
      
      const request: HttpRequest = {
        url: 'https://example.com/page',
        method: 'GET',
      };
      
      const result = filter.filter(request);
      
      assert.ok(result.allowed);
      assert.strictEqual(result.action, 'allow_public');
      assert.ok(result.stripCookies);
    });

    it('allows explicitly allowed requests', () => {
      const filter = new HttpFilter();
      filter.loadPolicy('example.com', {
        name: 'test',
        description: 'Test policy',
        default: 'deny',
        domains: ['example.com'],
        allowed_domains: ['example.com'],
        allowed_requests: [
          { url: 'https://example.com/api/public' },
        ],
        rules: [],
      });
      
      const request: HttpRequest = {
        url: 'https://example.com/api/public/data',
        method: 'GET',
      };
      
      const result = filter.filter(request);
      
      assert.ok(result.allowed);
    });
  });

  describe('sitemap matching', () => {
    it('matches request against sitemap entry', () => {
      const filter = new HttpFilter();
      
      const sitemap: SitemapEntry[] = [{
        category: 'api',
        semantic_action: 'Get user data',
        url: 'https://example.com/api/users/{userId}',
        method: 'GET',
        body: {},
        priority: 1,
      }];
      
      filter.loadSitemap('example.com', sitemap);
      filter.loadPolicy('example.com', {
        name: 'test',
        description: 'Test policy',
        default: 'allow',
        domains: ['example.com'],
        allowed_domains: ['example.com'],
        allowed_requests: [],
        rules: [],
      });
      
      const request: HttpRequest = {
        url: 'https://example.com/api/users/123',
        method: 'GET',
      };
      
      const result = filter.filter(request);
      
      assert.ok(result.allowed);
      assert.ok(result.matchedEntry);
      assert.strictEqual(result.matchedEntry.semantic_action, 'Get user data');
    });

    it('matches wildcard URL patterns', () => {
      const filter = new HttpFilter();
      
      const sitemap: SitemapEntry[] = [{
        category: 'api',
        semantic_action: 'List items',
        url: 'https://example.com/api/*',
        method: 'GET',
        body: {},
        priority: 1,
      }];
      
      filter.loadSitemap('example.com', sitemap);
      filter.loadPolicy('example.com', {
        name: 'test',
        description: 'Test',
        default: 'allow',
        domains: ['example.com'],
        allowed_domains: ['example.com'],
        allowed_requests: [],
        rules: [],
      });
      
      const request: HttpRequest = {
        url: 'https://example.com/api/items/list',
        method: 'GET',
      };
      
      const result = filter.filter(request);
      
      assert.ok(result.matchedEntry);
      assert.strictEqual(result.matchedEntry.semantic_action, 'List items');
    });

    it('matches request method', () => {
      const filter = new HttpFilter();
      
      const sitemap: SitemapEntry[] = [
        {
          category: 'api',
          semantic_action: 'Get item',
          url: 'https://example.com/api/item',
          method: 'GET',
          body: {},
          priority: 1,
        },
        {
          category: 'api',
          semantic_action: 'Create item',
          url: 'https://example.com/api/item',
          method: 'POST',
          body: {},
          priority: 1,
        },
      ];
      
      filter.loadSitemap('example.com', sitemap);
      filter.loadPolicy('example.com', {
        name: 'test',
        description: 'Test',
        default: 'allow',
        domains: ['example.com'],
        allowed_domains: ['example.com'],
        allowed_requests: [],
        rules: [],
      });
      
      const postRequest: HttpRequest = {
        url: 'https://example.com/api/item',
        method: 'POST',
      };
      
      const result = filter.filter(postRequest);
      
      assert.ok(result.matchedEntry);
      assert.strictEqual(result.matchedEntry.semantic_action, 'Create item');
    });

    it('matches request body pattern', () => {
      const filter = new HttpFilter();
      
      const sitemap: SitemapEntry[] = [{
        category: 'graphql',
        semantic_action: 'Delete item',
        url: 'https://example.com/graphql',
        method: 'POST',
        body: { operationName: 'deleteItem' },
        priority: 1,
      }];
      
      filter.loadSitemap('example.com', sitemap);
      filter.loadPolicy('example.com', {
        name: 'test',
        description: 'Test',
        default: 'allow',
        domains: ['example.com'],
        allowed_domains: ['example.com'],
        allowed_requests: [],
        rules: [],
      });
      
      const request: HttpRequest = {
        url: 'https://example.com/graphql',
        method: 'POST',
        body: {
          operationName: 'deleteItem',
          variables: { id: '123' },
        },
      };
      
      const result = filter.filter(request);
      
      assert.ok(result.matchedEntry);
      assert.strictEqual(result.matchedEntry.semantic_action, 'Delete item');
    });
  });

  describe('domain matching', () => {
    it('matches exact domain', () => {
      const filter = new HttpFilter();
      filter.loadPolicy('example.com', {
        name: 'test',
        description: 'Test',
        default: 'allow',
        domains: ['example.com'],
        allowed_domains: ['example.com'],
        allowed_requests: [],
        rules: [],
      });
      
      const request: HttpRequest = {
        url: 'https://example.com/page',
        method: 'GET',
      };
      
      const result = filter.filter(request);
      assert.ok(result.allowed);
    });

    it('matches subdomain', () => {
      const filter = new HttpFilter();
      filter.loadPolicy('example.com', {
        name: 'test',
        description: 'Test',
        default: 'allow',
        domains: ['example.com'],
        allowed_domains: ['example.com'],
        allowed_requests: [],
        rules: [],
      });
      
      const request: HttpRequest = {
        url: 'https://api.example.com/data',
        method: 'GET',
      };
      
      const result = filter.filter(request);
      assert.ok(result.allowed);
    });

    it('does not match partial domain names', () => {
      const filter = new HttpFilter();
      filter.setPredictedAllowlist(['example.com'], true);
      
      const request: HttpRequest = {
        url: 'https://notexample.com/page',
        method: 'GET',
      };
      
      const result = filter.filter(request);
      assert.ok(!result.allowed);
    });
  });
});

describe('createFilterFromIntent', () => {
  it('creates filter with predicted allowlist from intent', () => {
    const intent = parseIntent('Check prices on amazon.com');
    const filter = createFilterFromIntent(intent);
    
    // Should allow amazon.com
    const allowedRequest: HttpRequest = {
      url: 'https://amazon.com/product',
      method: 'GET',
    };
    
    const result = filter.filter(allowedRequest);
    assert.ok(result.allowed);
  });

  it('blocks domains not in intent', () => {
    const intent = parseIntent('Check prices on amazon.com');
    const filter = createFilterFromIntent(intent);
    
    const blockedRequest: HttpRequest = {
      url: 'https://evil.com/steal',
      method: 'GET',
    };
    
    const result = filter.filter(blockedRequest);
    assert.ok(!result.allowed);
  });

  it('uses allow_public for extract tasks', () => {
    const intent = parseIntent('Extract data from example.com');
    const filter = createFilterFromIntent(intent);
    
    const request: HttpRequest = {
      url: 'https://example.com/data',
      method: 'GET',
    };
    
    const result = filter.filter(request);
    
    assert.ok(result.allowed);
    assert.strictEqual(result.action, 'allow_public');
    assert.ok(result.stripCookies);
  });
});

describe('HttpFilter.predictAllowlistFromIntent', () => {
  it('includes intent allowed domains', () => {
    const intent = parseIntent('Check example.com');
    const allowlist = HttpFilter.predictAllowlistFromIntent(intent);
    
    assert.ok(allowlist.includes('example.com'));
  });

  it('adds GitHub-related domains for github.com', () => {
    const intent = parseIntent('Check github.com');
    const allowlist = HttpFilter.predictAllowlistFromIntent(intent);
    
    assert.ok(allowlist.includes('github.com'));
    assert.ok(allowlist.includes('githubusercontent.com'));
    assert.ok(allowlist.includes('github.githubassets.com'));
    assert.ok(allowlist.includes('api.github.com'));
  });

  it('adds GitLab-related domains for gitlab.com', () => {
    const intent = parseIntent('Check gitlab.com');
    const allowlist = HttpFilter.predictAllowlistFromIntent(intent);
    
    assert.ok(allowlist.includes('gitlab.com'));
    assert.ok(allowlist.includes('gitlab.net'));
  });
});
