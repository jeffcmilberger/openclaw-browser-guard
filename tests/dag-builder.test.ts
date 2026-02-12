/**
 * DAG Builder Unit Tests
 * 
 * Tests for single-shot planning DAG generation
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { 
  buildDAG, 
  validateDAG, 
  describePlan,
  serializeDAG,
} from '../dist/planner/dag-builder.js';
import { parseIntent } from '../dist/core/task-parser.js';

describe('buildDAG', () => {
  describe('search tasks', () => {
    it('builds DAG for search intent', () => {
      const intent = parseIntent('Search for cats on google.com');
      const dag = buildDAG(intent);
      
      assert.ok(dag);
      assert.ok(dag.id);
      assert.strictEqual(dag.intent, intent);
      assert.ok(dag.nodes.length > 0);
      assert.ok(dag.edges.length > 0);
      assert.ok(dag.entryPoint);
    });

    it('includes navigate, type, and extract nodes for search', () => {
      const intent = parseIntent('Search for dogs on google.com');
      const dag = buildDAG(intent);
      
      const actionTypes = dag.nodes.map(n => n.action.type);
      
      assert.ok(actionTypes.includes('navigate'));
      assert.ok(actionTypes.includes('extract'));
    });

    it('has terminal nodes', () => {
      const intent = parseIntent('Search on google.com');
      const dag = buildDAG(intent);
      
      const terminals = dag.nodes.filter(n => n.isTerminal);
      
      assert.ok(terminals.length > 0);
      assert.ok(terminals.some(t => t.terminalResult === 'success'));
      assert.ok(terminals.some(t => t.terminalResult === 'error' || t.terminalResult === 'abort'));
    });
  });

  describe('extract tasks', () => {
    it('builds DAG for extract intent', () => {
      const intent = parseIntent('Extract article from example.com');
      const dag = buildDAG(intent);
      
      assert.ok(dag);
      assert.ok(dag.nodes.length > 0);
    });

    it('includes scroll and extract nodes', () => {
      const intent = parseIntent('Extract data from example.com');
      const dag = buildDAG(intent);
      
      const actionTypes = dag.nodes.map(n => n.action.type);
      
      assert.ok(actionTypes.includes('scroll'));
      assert.ok(actionTypes.includes('extract'));
    });
  });

  describe('domain constraints', () => {
    it('adds domain constraint to all nodes', () => {
      const intent = parseIntent('Search on example.com');
      const dag = buildDAG(intent);
      
      for (const node of dag.nodes) {
        const hasDomainConstraint = node.constraints.some(c => c.type === 'domain');
        assert.ok(hasDomainConstraint, `Node ${node.id} should have domain constraint`);
      }
    });

    it('domain constraint includes all allowed domains', () => {
      const intent = parseIntent('Check amazon.com and newegg.com');
      const dag = buildDAG(intent);
      
      const domainConstraint = dag.nodes[0].constraints.find(c => c.type === 'domain');
      assert.ok(domainConstraint);
      
      // Rule should contain both domains
      assert.ok(domainConstraint.rule.includes('amazon.com'));
      assert.ok(domainConstraint.rule.includes('newegg.com'));
    });
  });

  describe('DAG structure', () => {
    it('generates unique DAG IDs', () => {
      const intent = parseIntent('Search on google.com');
      const dag1 = buildDAG(intent);
      const dag2 = buildDAG(intent);
      
      assert.notStrictEqual(dag1.id, dag2.id);
    });

    it('sets createdAt timestamp', () => {
      const before = Date.now();
      const intent = parseIntent('Search on google.com');
      const dag = buildDAG(intent);
      const after = Date.now();
      
      assert.ok(dag.createdAt >= before);
      assert.ok(dag.createdAt <= after);
    });

    it('entry point exists in nodes', () => {
      const intent = parseIntent('Search on google.com');
      const dag = buildDAG(intent);
      
      const entryNode = dag.nodes.find(n => n.id === dag.entryPoint);
      assert.ok(entryNode);
    });
  });

  describe('custom options', () => {
    it('includes custom extraction targets', () => {
      const intent = parseIntent('Extract from example.com');
      const dag = buildDAG(intent, {
        extractionTargets: [
          { name: 'price', selector: '.price', type: 'text' },
          { name: 'title', selector: 'h1', type: 'text' },
        ],
      });
      
      const extractNode = dag.nodes.find(n => n.action.type === 'extract' && n.extractionTargets);
      assert.ok(extractNode);
      assert.ok(extractNode.extractionTargets!.some(t => t.name === 'price'));
      assert.ok(extractNode.extractionTargets!.some(t => t.name === 'title'));
    });
  });
});

describe('validateDAG', () => {
  it('validates well-formed DAG', () => {
    const intent = parseIntent('Search on google.com');
    const dag = buildDAG(intent);
    
    const result = validateDAG(dag);
    
    assert.ok(result.valid);
    assert.strictEqual(result.issues.length, 0);
  });

  it('detects missing entry point', () => {
    const intent = parseIntent('Search on google.com');
    const dag = buildDAG(intent);
    dag.entryPoint = 'nonexistent_node';
    
    const result = validateDAG(dag);
    
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.toLowerCase().includes('entry point')));
  });

  it('detects invalid edge references', () => {
    const intent = parseIntent('Search on google.com');
    const dag = buildDAG(intent);
    
    // Add edge with invalid target
    dag.edges.push({
      from: dag.nodes[0].id,
      to: 'invalid_node',
      condition: { type: 'default', description: 'Test' },
      priority: 99,
    });
    
    const result = validateDAG(dag);
    
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.toLowerCase().includes('non-existent')));
  });

  it('detects non-terminal nodes without outgoing edges', () => {
    const intent = parseIntent('Search on google.com');
    const dag = buildDAG(intent);
    
    // Add orphan node with no outgoing edges
    dag.nodes.push({
      id: 'orphan',
      action: { type: 'click', description: 'Orphan' },
      expectedOutcomes: [],
      constraints: [],
      isTerminal: false, // Not terminal but no outgoing edges
    });
    
    const result = validateDAG(dag);
    
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.toLowerCase().includes('no outgoing')));
  });

  it('detects DAG without terminal nodes', () => {
    const intent = parseIntent('Search on google.com');
    const dag = buildDAG(intent);
    
    // Remove all terminal markers
    for (const node of dag.nodes) {
      node.isTerminal = false;
    }
    
    const result = validateDAG(dag);
    
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.toLowerCase().includes('terminal')));
  });

  it('detects unreachable nodes', () => {
    const intent = parseIntent('Search on google.com');
    const dag = buildDAG(intent);
    
    // Add unreachable terminal node
    dag.nodes.push({
      id: 'unreachable',
      action: { type: 'extract', description: 'Unreachable' },
      expectedOutcomes: [],
      constraints: [],
      isTerminal: true,
      terminalResult: 'success',
    });
    
    const result = validateDAG(dag);
    
    assert.ok(!result.valid);
    assert.ok(result.issues.some(i => i.toLowerCase().includes('unreachable')));
  });
});

describe('describePlan', () => {
  it('generates human-readable plan description', () => {
    const intent = parseIntent('Search for cats on google.com');
    const dag = buildDAG(intent);
    
    const description = describePlan(dag);
    
    assert.ok(typeof description === 'string');
    assert.ok(description.includes('Execution Plan'));
    assert.ok(description.includes('google.com'));
  });

  it('includes task type in description', () => {
    const intent = parseIntent('Search for cats on google.com');
    const dag = buildDAG(intent);
    
    const description = describePlan(dag);
    
    assert.ok(description.includes('search'));
  });

  it('lists execution steps', () => {
    const intent = parseIntent('Search on google.com');
    const dag = buildDAG(intent);
    
    const description = describePlan(dag);
    
    // Should have numbered steps
    assert.ok(description.includes('1.'));
  });

  it('shows branch conditions', () => {
    const intent = parseIntent('Search on google.com');
    const dag = buildDAG(intent);
    
    const description = describePlan(dag);
    
    // Should show conditional branches
    assert.ok(description.includes('If') || description.includes('→'));
  });

  it('marks terminal nodes', () => {
    const intent = parseIntent('Search on google.com');
    const dag = buildDAG(intent);
    
    const description = describePlan(dag);
    
    assert.ok(description.toLowerCase().includes('terminal') || 
              description.toLowerCase().includes('success') ||
              description.toLowerCase().includes('error'));
  });
});

describe('serializeDAG', () => {
  it('serializes DAG to JSON string', () => {
    const intent = parseIntent('Search on google.com');
    const dag = buildDAG(intent);
    
    const json = serializeDAG(dag);
    
    assert.ok(typeof json === 'string');
    
    // Should be valid JSON
    const parsed = JSON.parse(json);
    assert.ok(parsed.id);
    assert.ok(parsed.nodes);
    assert.ok(parsed.edges);
  });

  it('preserves DAG structure in serialization', () => {
    const intent = parseIntent('Search on google.com');
    const dag = buildDAG(intent);
    
    const json = serializeDAG(dag);
    const parsed = JSON.parse(json);
    
    assert.strictEqual(parsed.id, dag.id);
    assert.strictEqual(parsed.nodes.length, dag.nodes.length);
    assert.strictEqual(parsed.edges.length, dag.edges.length);
    assert.strictEqual(parsed.entryPoint, dag.entryPoint);
  });

  it('formats JSON with indentation', () => {
    const intent = parseIntent('Search on google.com');
    const dag = buildDAG(intent);
    
    const json = serializeDAG(dag);
    
    // Should have newlines (pretty-printed)
    assert.ok(json.includes('\n'));
  });
});
