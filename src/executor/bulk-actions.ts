/**
 * Bulk Actions System
 * 
 * Based on production insights from "Building Browser Agents" (arXiv:2511.19477)
 * 
 * Results from their testing:
 * - 74% fewer tool calls (10 vs 38)
 * - 57% faster execution (104.5s vs 245.1s)
 * - 41% fewer tokens (154K vs 260K)
 * 
 * Key insight: For form filling and other independent actions, batching
 * multiple actions into a single call dramatically improves efficiency
 * without sacrificing reliability.
 */

import type { BrowserAction } from '../core/types.js';
import { type VersionedRef, parseRef, type ElementRefManager } from './element-refs.js';

// ============================================================================
// Types
// ============================================================================

export interface BulkAction {
  type: BrowserAction['type'];
  ref: string;  // Versioned ref (e.g., "3:42")
  
  // Type-specific parameters
  text?: string;        // For 'type' actions
  shouldClear?: boolean;
  values?: string[];    // For 'select' actions
  doubleClick?: boolean;
  rightClick?: boolean;
}

export interface BulkActionResult {
  index: number;
  action: BulkAction;
  success: boolean;
  error?: string;
}

export interface BulkExecutionResult {
  success: boolean;
  results: BulkActionResult[];
  failedAt?: number;
  totalTime: number;
}

// ============================================================================
// Bulk Action Validation
// ============================================================================

/**
 * Check if actions can be safely batched together
 * 
 * Actions can be batched if they are "independent" - i.e., the result
 * of one doesn't affect the ability to execute another.
 * 
 * Safe to batch:
 * - Multiple type actions on different fields
 * - Multiple select actions on different dropdowns
 * - Click + type sequences on the same form
 * 
 * NOT safe to batch:
 * - Actions that trigger navigation
 * - Actions that open/close dialogs
 * - Actions where order matters for state changes
 */
export function canBatchActions(actions: BulkAction[]): { canBatch: boolean; reason?: string } {
  if (actions.length === 0) {
    return { canBatch: false, reason: 'No actions to batch' };
  }
  
  if (actions.length === 1) {
    return { canBatch: true };
  }
  
  // Check for navigation triggers
  const hasNavigation = actions.some(a => a.type === 'navigate');
  if (hasNavigation) {
    return { canBatch: false, reason: 'Cannot batch navigation actions' };
  }
  
  // Check for potential dialog triggers (clicks on buttons with certain labels)
  // This is a heuristic - in production, would check element labels
  
  // Check all refs are from same snapshot version
  const versions = new Set<number>();
  for (const action of actions) {
    const parsed = parseRef(action.ref);
    if (parsed) {
      versions.add(parsed.version);
    }
  }
  
  if (versions.size > 1) {
    return { canBatch: false, reason: 'Actions reference different snapshot versions' };
  }
  
  // Check for duplicate refs (same element targeted multiple times)
  const refs = actions.map(a => a.ref);
  const uniqueRefs = new Set(refs);
  if (uniqueRefs.size !== refs.length) {
    // Duplicates might be okay (e.g., clear then type), but flag for review
    // Actually, the paper suggests this is fine for clear+type patterns
  }
  
  return { canBatch: true };
}

/**
 * Optimize a sequence of actions for bulk execution
 * 
 * Strategies:
 * 1. Group independent actions together
 * 2. Identify natural batch boundaries (navigation, dialogs)
 * 3. Merge clear+type sequences
 */
export function optimizeActionSequence(actions: BulkAction[]): BulkAction[][] {
  const batches: BulkAction[][] = [];
  let currentBatch: BulkAction[] = [];
  
  for (const action of actions) {
    // Check if this action can be added to current batch
    const testBatch = [...currentBatch, action];
    const { canBatch } = canBatchActions(testBatch);
    
    if (canBatch) {
      currentBatch.push(action);
    } else {
      // Start new batch
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }
      currentBatch = [action];
    }
  }
  
  // Don't forget the last batch
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  
  return batches;
}

// ============================================================================
// Bulk Action Builder (for LLM output parsing)
// ============================================================================

/**
 * Parse bulk actions from LLM JSON output
 * 
 * Expected format:
 * {
 *   "bulkActions": [
 *     { "type": "type", "ref": "3:10", "text": "hello" },
 *     { "type": "type", "ref": "3:11", "text": "world" },
 *     { "type": "click", "ref": "3:15" }
 *   ]
 * }
 */
export function parseBulkActions(json: unknown): BulkAction[] | { error: string } {
  if (typeof json !== 'object' || json === null) {
    return { error: 'Expected object with bulkActions array' };
  }
  
  const obj = json as Record<string, unknown>;
  
  // Accept both "bulkActions" and "actions" keys
  const actionsArray = obj.bulkActions ?? obj.actions;
  
  if (!Array.isArray(actionsArray)) {
    return { error: 'Expected bulkActions to be an array' };
  }
  
  const actions: BulkAction[] = [];
  
  for (let i = 0; i < actionsArray.length; i++) {
    const item = actionsArray[i];
    
    if (typeof item !== 'object' || item === null) {
      return { error: `Action at index ${i} is not an object` };
    }
    
    const action = item as Record<string, unknown>;
    
    // Validate required fields
    if (typeof action.type !== 'string') {
      return { error: `Action at index ${i} missing 'type'` };
    }
    
    if (typeof action.ref !== 'string') {
      return { error: `Action at index ${i} missing 'ref'` };
    }
    
    // Validate ref format
    const parsed = parseRef(action.ref);
    if (!parsed) {
      return { error: `Action at index ${i} has invalid ref format: ${action.ref}` };
    }
    
    // Build action
    const bulkAction: BulkAction = {
      type: action.type as BrowserAction['type'],
      ref: action.ref,
    };
    
    // Add optional fields
    if (typeof action.text === 'string') bulkAction.text = action.text;
    if (typeof action.shouldClear === 'boolean') bulkAction.shouldClear = action.shouldClear;
    if (Array.isArray(action.values)) bulkAction.values = action.values as string[];
    if (typeof action.doubleClick === 'boolean') bulkAction.doubleClick = action.doubleClick;
    if (typeof action.rightClick === 'boolean') bulkAction.rightClick = action.rightClick;
    
    actions.push(bulkAction);
  }
  
  return actions;
}

/**
 * Serialize bulk actions to JSON for LLM consumption
 */
export function serializeBulkActions(actions: BulkAction[]): string {
  return JSON.stringify({ bulkActions: actions }, null, 2);
}

// ============================================================================
// Form Field Detection (for intelligent batching)
// ============================================================================

/**
 * Detect if a set of actions appears to be form filling
 * 
 * Form filling is highly amenable to batching because:
 * - Fields are independent
 * - Order usually doesn't matter
 * - No navigation between fields
 */
export function isFormFillingPattern(actions: BulkAction[]): boolean {
  if (actions.length < 2) return false;
  
  // Check if mostly type/select actions
  const formActions = actions.filter(a => 
    a.type === 'type' || a.type === 'click' || a.type === 'scroll'
  );
  
  return formActions.length >= actions.length * 0.7; // 70% threshold
}

/**
 * Generate example bulk action for form filling
 */
export function generateFormFillExample(fields: Array<{ ref: string; value: string }>): BulkAction[] {
  return fields.map(f => ({
    type: 'type' as const,
    ref: f.ref,
    text: f.value,
    shouldClear: true,
  }));
}

// ============================================================================
// Execution Statistics
// ============================================================================

export interface BulkExecutionStats {
  totalActions: number;
  batchCount: number;
  avgBatchSize: number;
  estimatedTimeSaved: number; // ms
  estimatedTokensSaved: number;
}

/**
 * Estimate efficiency gains from bulk execution
 * 
 * Based on paper's findings:
 * - Sequential: ~6.4s per action
 * - Bulk: ~10.5s per batch (regardless of size, up to ~10 actions)
 */
export function estimateEfficiencyGains(
  actionCount: number,
  batchCount: number
): BulkExecutionStats {
  const SEQUENTIAL_TIME_PER_ACTION = 6400; // ms
  const BULK_TIME_PER_BATCH = 10500; // ms
  const TOKENS_PER_SEQUENTIAL_CALL = 6800; // approx
  const TOKENS_PER_BULK_CALL = 8000; // approx (slightly more for the JSON)
  
  const sequentialTime = actionCount * SEQUENTIAL_TIME_PER_ACTION;
  const bulkTime = batchCount * BULK_TIME_PER_BATCH;
  
  const sequentialTokens = actionCount * TOKENS_PER_SEQUENTIAL_CALL;
  const bulkTokens = batchCount * TOKENS_PER_BULK_CALL;
  
  return {
    totalActions: actionCount,
    batchCount,
    avgBatchSize: actionCount / batchCount,
    estimatedTimeSaved: sequentialTime - bulkTime,
    estimatedTokensSaved: sequentialTokens - bulkTokens,
  };
}
