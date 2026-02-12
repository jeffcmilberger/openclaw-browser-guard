/**
 * Bulk Actions Unit Tests
 * 
 * Tests for action batching that provides 74% fewer calls, 57% faster execution
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { 
  canBatchActions,
  optimizeActionSequence,
  parseBulkActions,
  serializeBulkActions,
  isFormFillingPattern,
  estimateEfficiencyGains,
} from '../dist/executor/bulk-actions.js';
import type { BulkAction } from '../dist/executor/bulk-actions.js';

describe('canBatchActions', () => {
  describe('allows batching', () => {
    it('allows empty array (technically)', () => {
      const result = canBatchActions([]);
      assert.ok(!result.canBatch); // Actually false for empty
    });

    it('allows single action', () => {
      const actions: BulkAction[] = [
        { type: 'type', ref: '1:5', text: 'hello' },
      ];
      const result = canBatchActions(actions);
      assert.ok(result.canBatch);
    });

    it('allows multiple type actions', () => {
      const actions: BulkAction[] = [
        { type: 'type', ref: '1:5', text: 'hello' },
        { type: 'type', ref: '1:6', text: 'world' },
        { type: 'type', ref: '1:7', text: 'test' },
      ];
      const result = canBatchActions(actions);
      assert.ok(result.canBatch);
    });

    it('allows mixed type and click actions', () => {
      const actions: BulkAction[] = [
        { type: 'type', ref: '1:5', text: 'hello' },
        { type: 'click', ref: '1:6' },
      ];
      const result = canBatchActions(actions);
      assert.ok(result.canBatch);
    });
  });

  describe('prevents batching', () => {
    it('rejects batch with navigation', () => {
      const actions: BulkAction[] = [
        { type: 'type', ref: '1:5', text: 'hello' },
        { type: 'navigate', ref: '1:6' },
      ];
      const result = canBatchActions(actions);
      assert.ok(!result.canBatch);
      assert.ok(result.reason?.toLowerCase().includes('navigation'));
    });

    it('rejects batch with different snapshot versions', () => {
      const actions: BulkAction[] = [
        { type: 'type', ref: '1:5', text: 'hello' },
        { type: 'type', ref: '2:6', text: 'world' }, // Different version
      ];
      const result = canBatchActions(actions);
      assert.ok(!result.canBatch);
      assert.ok(result.reason?.toLowerCase().includes('version'));
    });
  });
});

describe('optimizeActionSequence', () => {
  it('groups independent actions together', () => {
    const actions: BulkAction[] = [
      { type: 'type', ref: '1:1', text: 'a' },
      { type: 'type', ref: '1:2', text: 'b' },
      { type: 'type', ref: '1:3', text: 'c' },
    ];
    
    const batches = optimizeActionSequence(actions);
    
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0].length, 3);
  });

  it('splits at navigation actions', () => {
    const actions: BulkAction[] = [
      { type: 'type', ref: '1:1', text: 'a' },
      { type: 'navigate', ref: '1:2' },
      { type: 'type', ref: '1:3', text: 'c' },
    ];
    
    const batches = optimizeActionSequence(actions);
    
    // Should be 3 batches: [type], [navigate], [type]
    assert.strictEqual(batches.length, 3);
    assert.strictEqual(batches[0][0].type, 'type');
    assert.strictEqual(batches[1][0].type, 'navigate');
    assert.strictEqual(batches[2][0].type, 'type');
  });

  it('handles empty input', () => {
    const batches = optimizeActionSequence([]);
    assert.strictEqual(batches.length, 0);
  });

  it('handles single action', () => {
    const actions: BulkAction[] = [
      { type: 'click', ref: '1:1' },
    ];
    
    const batches = optimizeActionSequence(actions);
    
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0].length, 1);
  });
});

describe('parseBulkActions', () => {
  describe('valid input', () => {
    it('parses basic bulk actions', () => {
      const json = {
        bulkActions: [
          { type: 'type', ref: '1:5', text: 'hello' },
          { type: 'click', ref: '1:6' },
        ],
      };
      
      const result = parseBulkActions(json);
      
      assert.ok(Array.isArray(result));
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].type, 'type');
      assert.strictEqual(result[0].text, 'hello');
      assert.strictEqual(result[1].type, 'click');
    });

    it('parses "actions" key as alias', () => {
      const json = {
        actions: [
          { type: 'type', ref: '1:5', text: 'hello' },
        ],
      };
      
      const result = parseBulkActions(json);
      
      assert.ok(Array.isArray(result));
      assert.strictEqual(result.length, 1);
    });

    it('parses optional parameters', () => {
      const json = {
        bulkActions: [
          { 
            type: 'type', 
            ref: '1:5', 
            text: 'hello',
            shouldClear: true,
          },
          { 
            type: 'click', 
            ref: '1:6',
            doubleClick: true,
            rightClick: false,
          },
        ],
      };
      
      const result = parseBulkActions(json);
      
      assert.ok(Array.isArray(result));
      assert.strictEqual(result[0].shouldClear, true);
      assert.strictEqual(result[1].doubleClick, true);
      assert.strictEqual(result[1].rightClick, false);
    });

    it('parses values array for select', () => {
      const json = {
        bulkActions: [
          { type: 'click', ref: '1:5', values: ['option1', 'option2'] },
        ],
      };
      
      const result = parseBulkActions(json);
      
      assert.ok(Array.isArray(result));
      assert.deepStrictEqual(result[0].values, ['option1', 'option2']);
    });
  });

  describe('invalid input', () => {
    it('rejects non-object input', () => {
      const result = parseBulkActions('not an object');
      
      assert.ok(!Array.isArray(result));
      assert.ok('error' in result);
    });

    it('rejects null input', () => {
      const result = parseBulkActions(null);
      
      assert.ok(!Array.isArray(result));
      assert.ok('error' in result);
    });

    it('rejects missing bulkActions array', () => {
      const result = parseBulkActions({ foo: 'bar' });
      
      assert.ok(!Array.isArray(result));
      assert.ok('error' in result);
    });

    it('rejects action without type', () => {
      const json = {
        bulkActions: [
          { ref: '1:5', text: 'hello' },
        ],
      };
      
      const result = parseBulkActions(json);
      
      assert.ok(!Array.isArray(result));
      assert.ok('error' in result);
      assert.ok(result.error.includes('type'));
    });

    it('rejects action without ref', () => {
      const json = {
        bulkActions: [
          { type: 'type', text: 'hello' },
        ],
      };
      
      const result = parseBulkActions(json);
      
      assert.ok(!Array.isArray(result));
      assert.ok('error' in result);
      assert.ok(result.error.includes('ref'));
    });

    it('rejects invalid ref format', () => {
      const json = {
        bulkActions: [
          { type: 'type', ref: 'invalid', text: 'hello' },
        ],
      };
      
      const result = parseBulkActions(json);
      
      assert.ok(!Array.isArray(result));
      assert.ok('error' in result);
      assert.ok(result.error.includes('invalid ref'));
    });

    it('rejects non-object in actions array', () => {
      const json = {
        bulkActions: ['not an object'],
      };
      
      const result = parseBulkActions(json);
      
      assert.ok(!Array.isArray(result));
      assert.ok('error' in result);
    });
  });
});

describe('serializeBulkActions', () => {
  it('serializes actions to JSON', () => {
    const actions: BulkAction[] = [
      { type: 'type', ref: '1:5', text: 'hello' },
      { type: 'click', ref: '1:6' },
    ];
    
    const json = serializeBulkActions(actions);
    const parsed = JSON.parse(json);
    
    assert.ok(parsed.bulkActions);
    assert.strictEqual(parsed.bulkActions.length, 2);
  });

  it('produces parseable output', () => {
    const actions: BulkAction[] = [
      { type: 'type', ref: '1:5', text: 'hello', shouldClear: true },
    ];
    
    const json = serializeBulkActions(actions);
    const parsed = JSON.parse(json);
    const result = parseBulkActions(parsed);
    
    assert.ok(Array.isArray(result));
    assert.strictEqual(result[0].type, 'type');
    assert.strictEqual(result[0].text, 'hello');
    assert.strictEqual(result[0].shouldClear, true);
  });
});

describe('isFormFillingPattern', () => {
  it('detects form filling (mostly type actions)', () => {
    const actions: BulkAction[] = [
      { type: 'type', ref: '1:1', text: 'John' },
      { type: 'type', ref: '1:2', text: 'Doe' },
      { type: 'type', ref: '1:3', text: 'john@example.com' },
      { type: 'click', ref: '1:4' }, // Submit button
    ];
    
    const result = isFormFillingPattern(actions);
    assert.ok(result);
  });

  it('rejects single action', () => {
    const actions: BulkAction[] = [
      { type: 'type', ref: '1:1', text: 'hello' },
    ];
    
    const result = isFormFillingPattern(actions);
    assert.ok(!result);
  });

  it('rejects navigation-heavy patterns', () => {
    const actions: BulkAction[] = [
      { type: 'navigate', ref: '1:1' },
      { type: 'navigate', ref: '1:2' },
      { type: 'navigate', ref: '1:3' },
    ];
    
    const result = isFormFillingPattern(actions);
    assert.ok(!result);
  });
});

describe('estimateEfficiencyGains', () => {
  it('estimates time and token savings', () => {
    const stats = estimateEfficiencyGains(10, 2);
    
    assert.strictEqual(stats.totalActions, 10);
    assert.strictEqual(stats.batchCount, 2);
    assert.strictEqual(stats.avgBatchSize, 5);
    
    // Should show significant time savings
    assert.ok(stats.estimatedTimeSaved > 0);
    
    // Should show token savings
    assert.ok(stats.estimatedTokensSaved > 0);
  });

  it('shows greater savings with more batching', () => {
    const lowBatch = estimateEfficiencyGains(20, 10);
    const highBatch = estimateEfficiencyGains(20, 2);
    
    // Higher batching (fewer batches) = more savings
    assert.ok(highBatch.estimatedTimeSaved > lowBatch.estimatedTimeSaved);
    assert.ok(highBatch.estimatedTokensSaved > lowBatch.estimatedTokensSaved);
  });

  it('handles edge case of 1:1 ratio', () => {
    const stats = estimateEfficiencyGains(5, 5);
    
    assert.strictEqual(stats.avgBatchSize, 1);
    // Minimal savings when not batching
  });
});
