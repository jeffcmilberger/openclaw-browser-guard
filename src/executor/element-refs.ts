/**
 * Element Reference System with Snapshot Versioning
 * 
 * Based on production insights from "Building Browser Agents" (arXiv:2511.19477)
 * 
 * Problem: A "Cancel" button with ref=10 in one snapshot might become a
 * "Delete" button with the same ref after a page update. Operating on
 * stale references can cause catastrophic unintended actions.
 * 
 * Solution: Version all refs as "snapshotVersion:elementRef" (e.g., "3:42").
 * When executing, verify the requested version matches current state.
 * If versions mismatch, fail safely.
 */

import type { ObservedElement, Observation } from '../core/types.js';

// ============================================================================
// Types
// ============================================================================

export interface VersionedRef {
  /** Snapshot version number */
  version: number;
  
  /** Element reference within that snapshot */
  ref: number;
  
  /** String representation (e.g., "3:42") */
  toString(): string;
}

export interface ElementSnapshot {
  /** Snapshot version */
  version: number;
  
  /** Timestamp when snapshot was taken */
  timestamp: number;
  
  /** URL when snapshot was taken */
  url: string;
  
  /** Elements in this snapshot */
  elements: Map<number, SnapshotElement>;
}

export interface SnapshotElement {
  ref: number;
  selector: string;
  tagName: string;
  role?: string;
  label?: string;
  text?: string;
  attributes: Record<string, string>;
  
  /** Hash of element identity for staleness detection */
  identityHash: string;
}

// ============================================================================
// Ref Parsing
// ============================================================================

/**
 * Parse a versioned ref string (e.g., "3:42" → { version: 3, ref: 42 })
 */
export function parseRef(refString: string): VersionedRef | null {
  const match = refString.match(/^(\d+):(\d+)$/);
  if (!match) return null;
  
  const version = parseInt(match[1], 10);
  const ref = parseInt(match[2], 10);
  
  return {
    version,
    ref,
    toString: () => `${version}:${ref}`,
  };
}

/**
 * Create a versioned ref
 */
export function createRef(version: number, ref: number): VersionedRef {
  return {
    version,
    ref,
    toString: () => `${version}:${ref}`,
  };
}

// ============================================================================
// Element Reference Manager
// ============================================================================

export class ElementRefManager {
  private currentVersion: number = 0;
  private snapshots: Map<number, ElementSnapshot> = new Map();
  private maxSnapshots: number = 5; // Keep last N snapshots for debugging
  
  constructor() {}
  
  /**
   * Create a new snapshot from observed elements
   */
  createSnapshot(url: string, elements: ObservedElement[]): ElementSnapshot {
    this.currentVersion++;
    
    const snapshot: ElementSnapshot = {
      version: this.currentVersion,
      timestamp: Date.now(),
      url,
      elements: new Map(),
    };
    
    for (let i = 0; i < elements.length; i++) {
      const elem = elements[i];
      const ref = i + 1; // 1-indexed refs
      
      snapshot.elements.set(ref, {
        ref,
        selector: elem.selector,
        tagName: elem.tagName,
        role: elem.attributes?.role,
        label: elem.attributes?.['aria-label'] || elem.text,
        text: elem.text,
        attributes: elem.attributes || {},
        identityHash: this.computeIdentityHash(elem),
      });
    }
    
    // Store snapshot
    this.snapshots.set(this.currentVersion, snapshot);
    
    // Prune old snapshots
    if (this.snapshots.size > this.maxSnapshots) {
      const oldestVersion = Math.min(...this.snapshots.keys());
      this.snapshots.delete(oldestVersion);
    }
    
    return snapshot;
  }
  
  /**
   * Get current snapshot version
   */
  getCurrentVersion(): number {
    return this.currentVersion;
  }
  
  /**
   * Get current snapshot
   */
  getCurrentSnapshot(): ElementSnapshot | undefined {
    return this.snapshots.get(this.currentVersion);
  }
  
  /**
   * Validate a versioned ref against current state
   * Returns the element if valid, or an error
   */
  validateRef(refString: string): { valid: true; element: SnapshotElement } | { valid: false; error: string } {
    const parsed = parseRef(refString);
    if (!parsed) {
      return { valid: false, error: `Invalid ref format: ${refString}` };
    }
    
    // Check version matches current
    if (parsed.version !== this.currentVersion) {
      return {
        valid: false,
        error: `Stale ref: requested version ${parsed.version}, current is ${this.currentVersion}. Page state may have changed.`,
      };
    }
    
    // Get element from current snapshot
    const snapshot = this.snapshots.get(parsed.version);
    if (!snapshot) {
      return { valid: false, error: `Snapshot ${parsed.version} not found` };
    }
    
    const element = snapshot.elements.get(parsed.ref);
    if (!element) {
      return { valid: false, error: `Element ref ${parsed.ref} not found in snapshot ${parsed.version}` };
    }
    
    return { valid: true, element };
  }
  
  /**
   * Check if an element has changed between snapshots
   * Used for additional safety verification
   */
  hasElementChanged(oldRef: string, currentSnapshot: ElementSnapshot): boolean {
    const parsed = parseRef(oldRef);
    if (!parsed) return true;
    
    const oldSnapshot = this.snapshots.get(parsed.version);
    if (!oldSnapshot) return true;
    
    const oldElement = oldSnapshot.elements.get(parsed.ref);
    const newElement = currentSnapshot.elements.get(parsed.ref);
    
    if (!oldElement || !newElement) return true;
    
    // Compare identity hashes
    return oldElement.identityHash !== newElement.identityHash;
  }
  
  /**
   * Format snapshot for LLM consumption
   */
  formatSnapshotForLLM(snapshot?: ElementSnapshot, maxElements: number = 200): string {
    const snap = snapshot || this.getCurrentSnapshot();
    if (!snap) return '[No snapshot available]';
    
    const lines: string[] = [
      `# Page Snapshot (version ${snap.version})`,
      `URL: ${snap.url}`,
      '',
    ];
    
    let count = 0;
    for (const [ref, elem] of snap.elements) {
      if (count >= maxElements) {
        lines.push(`... [${snap.elements.size - count} more elements trimmed]`);
        break;
      }
      
      const parts = [`ref=${snap.version}:${ref}`];
      
      if (elem.role) parts.push(elem.role);
      if (elem.label) parts.push(`"${elem.label}"`);
      if (elem.text && elem.text !== elem.label) parts.push(`text="${elem.text.slice(0, 50)}"`);
      
      // Add important attributes
      const attrs: string[] = [];
      if (elem.attributes.disabled) attrs.push('disabled');
      if (elem.attributes.required) attrs.push('required');
      if (elem.attributes.readonly) attrs.push('readonly');
      if (attrs.length > 0) parts.push(attrs.join(' '));
      
      lines.push(parts.join(' '));
      count++;
    }
    
    return lines.join('\n');
  }
  
  /**
   * Compute identity hash for staleness detection
   */
  private computeIdentityHash(elem: ObservedElement): string {
    // Hash based on stable identity properties
    const identity = [
      elem.tagName,
      elem.attributes?.role || '',
      elem.attributes?.['aria-label'] || '',
      elem.attributes?.name || '',
      elem.attributes?.id || '',
      elem.text?.slice(0, 100) || '',
    ].join('|');
    
    // Simple hash (in production, use proper hash function)
    let hash = 0;
    for (let i = 0; i < identity.length; i++) {
      const char = identity.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(16);
  }
}

// ============================================================================
// Sensitive Element Detection
// ============================================================================

/** 
 * Labels that indicate dangerous/sensitive actions
 * Based on production safety patterns from the paper
 */
const SENSITIVE_LABELS = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\brefund\b/i,
  /\bcancel\s*(order|subscription|account)/i,
  /\bpay\s*now\b/i,
  /\bpurchase\b/i,
  /\bsubmit\s*payment\b/i,
  /\btransfer\s*(funds|money)\b/i,
  /\bsend\s*money\b/i,
  /\bconfirm\s*(delete|removal|payment)\b/i,
  /\bpermanent(ly)?\b/i,
  /\birreversible\b/i,
  /\bclose\s*account\b/i,
  /\brevoke\b/i,
];

/**
 * Check if an element's label indicates a sensitive action
 */
export function isSensitiveElement(element: SnapshotElement): { sensitive: boolean; reason?: string } {
  const textToCheck = [
    element.label,
    element.text,
    element.attributes['aria-label'],
    element.attributes.value,
  ].filter(Boolean).join(' ');
  
  for (const pattern of SENSITIVE_LABELS) {
    if (pattern.test(textToCheck)) {
      return {
        sensitive: true,
        reason: `Element label matches sensitive pattern: ${pattern}`,
      };
    }
  }
  
  return { sensitive: false };
}

/**
 * Get all sensitive elements in a snapshot (for policy enforcement)
 */
export function findSensitiveElements(snapshot: ElementSnapshot): SnapshotElement[] {
  const sensitive: SnapshotElement[] = [];
  
  for (const element of snapshot.elements.values()) {
    if (isSensitiveElement(element).sensitive) {
      sensitive.push(element);
    }
  }
  
  return sensitive;
}
