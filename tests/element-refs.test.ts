/**
 * Element Reference System Unit Tests
 * 
 * Tests for versioned refs that prevent stale reference attacks
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { 
  ElementRefManager, 
  parseRef, 
  createRef,
  isSensitiveElement,
  findSensitiveElements,
} from '../dist/executor/element-refs.js';
import type { ObservedElement } from '../dist/core/types.js';

// Helper to create mock observed elements
function createElements(count: number): ObservedElement[] {
  const elements: ObservedElement[] = [];
  for (let i = 0; i < count; i++) {
    elements.push({
      selector: `#element-${i}`,
      tagName: 'button',
      text: `Button ${i}`,
      attributes: { id: `element-${i}` },
      visible: true,
    });
  }
  return elements;
}

describe('parseRef', () => {
  it('parses valid versioned ref', () => {
    const ref = parseRef('3:42');
    assert.ok(ref);
    assert.strictEqual(ref.version, 3);
    assert.strictEqual(ref.ref, 42);
  });

  it('parses single digit refs', () => {
    const ref = parseRef('1:5');
    assert.ok(ref);
    assert.strictEqual(ref.version, 1);
    assert.strictEqual(ref.ref, 5);
  });

  it('parses large numbers', () => {
    const ref = parseRef('100:999');
    assert.ok(ref);
    assert.strictEqual(ref.version, 100);
    assert.strictEqual(ref.ref, 999);
  });

  it('returns null for invalid format - no colon', () => {
    const ref = parseRef('42');
    assert.strictEqual(ref, null);
  });

  it('returns null for invalid format - non-numeric', () => {
    const ref = parseRef('abc:def');
    assert.strictEqual(ref, null);
  });

  it('returns null for empty string', () => {
    const ref = parseRef('');
    assert.strictEqual(ref, null);
  });

  it('returns null for partial ref', () => {
    const ref = parseRef('3:');
    assert.strictEqual(ref, null);
  });

  it('toString returns original format', () => {
    const ref = parseRef('5:10');
    assert.ok(ref);
    assert.strictEqual(ref.toString(), '5:10');
  });
});

describe('createRef', () => {
  it('creates ref with given version and ref number', () => {
    const ref = createRef(7, 25);
    assert.strictEqual(ref.version, 7);
    assert.strictEqual(ref.ref, 25);
    assert.strictEqual(ref.toString(), '7:25');
  });
});

describe('ElementRefManager', () => {
  describe('createSnapshot', () => {
    it('creates snapshot with incrementing version', () => {
      const manager = new ElementRefManager();
      const elements = createElements(3);
      
      const snap1 = manager.createSnapshot('https://example.com', elements);
      assert.strictEqual(snap1.version, 1);
      
      const snap2 = manager.createSnapshot('https://example.com/page2', elements);
      assert.strictEqual(snap2.version, 2);
    });

    it('stores URL in snapshot', () => {
      const manager = new ElementRefManager();
      const elements = createElements(2);
      
      const snap = manager.createSnapshot('https://test.com/page', elements);
      assert.strictEqual(snap.url, 'https://test.com/page');
    });

    it('assigns 1-indexed refs to elements', () => {
      const manager = new ElementRefManager();
      const elements = createElements(5);
      
      const snap = manager.createSnapshot('https://example.com', elements);
      
      assert.ok(snap.elements.has(1));
      assert.ok(snap.elements.has(5));
      assert.ok(!snap.elements.has(0)); // No 0-indexed ref
      assert.ok(!snap.elements.has(6)); // No extra refs
    });

    it('stores element properties correctly', () => {
      const manager = new ElementRefManager();
      const elements: ObservedElement[] = [{
        selector: '#submit-btn',
        tagName: 'button',
        text: 'Submit Form',
        attributes: { 
          id: 'submit-btn',
          role: 'button',
          'aria-label': 'Submit the form',
        },
        visible: true,
      }];
      
      const snap = manager.createSnapshot('https://example.com', elements);
      const elem = snap.elements.get(1);
      
      assert.ok(elem);
      assert.strictEqual(elem.selector, '#submit-btn');
      assert.strictEqual(elem.tagName, 'button');
      assert.strictEqual(elem.text, 'Submit Form');
      assert.strictEqual(elem.attributes.role, 'button');
    });
  });

  describe('getCurrentVersion', () => {
    it('returns 0 before any snapshots', () => {
      const manager = new ElementRefManager();
      assert.strictEqual(manager.getCurrentVersion(), 0);
    });

    it('returns latest version after snapshots', () => {
      const manager = new ElementRefManager();
      const elements = createElements(1);
      
      manager.createSnapshot('https://a.com', elements);
      manager.createSnapshot('https://b.com', elements);
      manager.createSnapshot('https://c.com', elements);
      
      assert.strictEqual(manager.getCurrentVersion(), 3);
    });
  });

  describe('validateRef', () => {
    it('validates ref from current snapshot', () => {
      const manager = new ElementRefManager();
      const elements = createElements(5);
      manager.createSnapshot('https://example.com', elements);
      
      const result = manager.validateRef('1:3');
      
      assert.ok(result.valid);
      if (result.valid) {
        assert.strictEqual(result.element.ref, 3);
      }
    });

    it('rejects ref from old snapshot (stale ref)', () => {
      const manager = new ElementRefManager();
      const elements = createElements(5);
      
      manager.createSnapshot('https://example.com', elements);
      manager.createSnapshot('https://example.com/page2', elements);
      
      // Try to use ref from version 1 when we're on version 2
      const result = manager.validateRef('1:3');
      
      assert.ok(!result.valid);
      if (!result.valid) {
        assert.ok(result.error.toLowerCase().includes('stale'));
      }
    });

    it('rejects ref with invalid format', () => {
      const manager = new ElementRefManager();
      const elements = createElements(5);
      manager.createSnapshot('https://example.com', elements);
      
      const result = manager.validateRef('invalid');
      
      assert.ok(!result.valid);
      if (!result.valid) {
        assert.ok(result.error.toLowerCase().includes('invalid'));
      }
    });

    it('rejects ref to non-existent element', () => {
      const manager = new ElementRefManager();
      const elements = createElements(3);
      manager.createSnapshot('https://example.com', elements);
      
      const result = manager.validateRef('1:99'); // Only 3 elements exist
      
      assert.ok(!result.valid);
      if (!result.valid) {
        assert.ok(result.error.toLowerCase().includes('not found'));
      }
    });
  });

  describe('formatSnapshotForLLM', () => {
    it('formats snapshot as readable text', () => {
      const manager = new ElementRefManager();
      const elements: ObservedElement[] = [{
        selector: '#btn',
        tagName: 'button',
        text: 'Click Me',
        attributes: { role: 'button', 'aria-label': 'Click button' },
        visible: true,
      }];
      
      manager.createSnapshot('https://example.com', elements);
      const formatted = manager.formatSnapshotForLLM();
      
      assert.ok(formatted.includes('version 1'));
      assert.ok(formatted.includes('example.com'));
      assert.ok(formatted.includes('ref=1:1'));
    });

    it('truncates large snapshots', () => {
      const manager = new ElementRefManager();
      const elements = createElements(300);
      manager.createSnapshot('https://example.com', elements);
      
      const formatted = manager.formatSnapshotForLLM(undefined, 50);
      
      assert.ok(formatted.includes('trimmed'));
      // Should have 50 elements + header + trimmed notice
      const lines = formatted.split('\n').filter(l => l.startsWith('ref='));
      assert.strictEqual(lines.length, 50);
    });
  });
});

describe('isSensitiveElement', () => {
  // Helper to create snapshot element
  function elem(text: string, label?: string): Parameters<typeof isSensitiveElement>[0] {
    return {
      ref: 1,
      selector: '#test',
      tagName: 'button',
      text,
      label,
      attributes: { 'aria-label': label || '' },
      identityHash: 'abc',
    };
  }

  describe('detects dangerous labels', () => {
    it('detects "delete" buttons', () => {
      const result = isSensitiveElement(elem('Delete'));
      assert.ok(result.sensitive);
    });

    it('detects "remove" buttons', () => {
      const result = isSensitiveElement(elem('Remove Item'));
      assert.ok(result.sensitive);
    });

    it('detects "refund" buttons', () => {
      const result = isSensitiveElement(elem('Request Refund'));
      assert.ok(result.sensitive);
    });

    it('detects "pay now" buttons', () => {
      const result = isSensitiveElement(elem('Pay Now'));
      assert.ok(result.sensitive);
    });

    it('detects "purchase" buttons', () => {
      const result = isSensitiveElement(elem('Complete Purchase'));
      assert.ok(result.sensitive);
    });

    it('detects "transfer funds" buttons', () => {
      const result = isSensitiveElement(elem('Transfer Funds'));
      assert.ok(result.sensitive);
    });

    it('detects "send money" buttons', () => {
      const result = isSensitiveElement(elem('Send Money'));
      assert.ok(result.sensitive);
    });

    it('detects "cancel subscription" buttons', () => {
      const result = isSensitiveElement(elem('Cancel Subscription'));
      assert.ok(result.sensitive);
    });

    it('detects "close account" buttons', () => {
      const result = isSensitiveElement(elem('Close Account'));
      assert.ok(result.sensitive);
    });

    it('detects "revoke" buttons', () => {
      const result = isSensitiveElement(elem('Revoke Access'));
      assert.ok(result.sensitive);
    });

    it('detects "permanent" labels', () => {
      const result = isSensitiveElement(elem('Permanently Delete'));
      assert.ok(result.sensitive);
    });

    it('detects "irreversible" labels', () => {
      const result = isSensitiveElement(elem('This action is irreversible'));
      assert.ok(result.sensitive);
    });
  });

  describe('allows safe labels', () => {
    it('allows "add to cart" buttons', () => {
      const result = isSensitiveElement(elem('Add to Cart'));
      assert.ok(!result.sensitive);
    });

    it('allows "save" buttons', () => {
      const result = isSensitiveElement(elem('Save Changes'));
      assert.ok(!result.sensitive);
    });

    it('allows "submit" buttons', () => {
      const result = isSensitiveElement(elem('Submit'));
      assert.ok(!result.sensitive);
    });

    it('allows "next" buttons', () => {
      const result = isSensitiveElement(elem('Next Step'));
      assert.ok(!result.sensitive);
    });

    it('allows "continue" buttons', () => {
      const result = isSensitiveElement(elem('Continue'));
      assert.ok(!result.sensitive);
    });
  });

  describe('checks aria-label', () => {
    it('detects sensitive aria-label', () => {
      const result = isSensitiveElement(elem('X', 'Delete this item'));
      assert.ok(result.sensitive);
    });
  });
});

describe('findSensitiveElements', () => {
  it('finds all sensitive elements in snapshot', () => {
    const manager = new ElementRefManager();
    const elements: ObservedElement[] = [
      { selector: '#a', tagName: 'button', text: 'Save', visible: true },
      { selector: '#b', tagName: 'button', text: 'Delete', visible: true },
      { selector: '#c', tagName: 'button', text: 'Cancel', visible: true },
      { selector: '#d', tagName: 'button', text: 'Pay Now', visible: true },
    ];
    
    const snap = manager.createSnapshot('https://example.com', elements);
    const sensitive = findSensitiveElements(snap);
    
    assert.strictEqual(sensitive.length, 2); // Delete and Pay Now
    assert.ok(sensitive.some(e => e.text === 'Delete'));
    assert.ok(sensitive.some(e => e.text === 'Pay Now'));
  });

  it('returns empty array when no sensitive elements', () => {
    const manager = new ElementRefManager();
    const elements: ObservedElement[] = [
      { selector: '#a', tagName: 'button', text: 'Save', visible: true },
      { selector: '#b', tagName: 'button', text: 'Submit', visible: true },
    ];
    
    const snap = manager.createSnapshot('https://example.com', elements);
    const sensitive = findSensitiveElements(snap);
    
    assert.strictEqual(sensitive.length, 0);
  });
});
