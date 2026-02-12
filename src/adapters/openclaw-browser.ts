/**
 * OpenClaw Browser Adapter
 * 
 * Connects Browser Guard to OpenClaw's browser tool.
 * Translates between our secure executor interface and OpenClaw's browser API.
 */

import type { BrowserAdapter } from '../executor/runtime.js';
import type { Observation, ObservedElement } from '../core/types.js';

// ============================================================================
// Types for OpenClaw Browser Tool
// ============================================================================

/**
 * OpenClaw browser tool request format
 */
export interface OpenClawBrowserRequest {
  action: 'snapshot' | 'screenshot' | 'navigate' | 'act';
  targetUrl?: string;
  targetId?: string;
  ref?: string;
  compact?: boolean;
  request?: {
    kind: 'click' | 'type' | 'press' | 'hover' | 'scroll' | 'select' | 'wait';
    ref?: string;
    text?: string;
    key?: string;
    slowly?: boolean;
    submit?: boolean;
    values?: string[];
    timeMs?: number;
  };
}

/**
 * OpenClaw browser snapshot response
 */
export interface OpenClawSnapshotResponse {
  ok: boolean;
  snapshot?: string;
  url?: string;
  title?: string;
  targetId?: string;
  error?: string;
}

/**
 * Callback type for invoking OpenClaw browser tool
 */
export type BrowserToolInvoker = (request: OpenClawBrowserRequest) => Promise<OpenClawSnapshotResponse>;

// ============================================================================
// Browser Adapter Implementation
// ============================================================================

export class OpenClawBrowserAdapter implements BrowserAdapter {
  private invoker: BrowserToolInvoker;
  private currentUrl: string = '';
  private currentTitle: string = '';
  private targetId?: string;
  
  constructor(invoker: BrowserToolInvoker) {
    this.invoker = invoker;
  }
  
  /**
   * Navigate to a URL
   */
  async navigate(url: string): Promise<Observation> {
    const response = await this.invoker({
      action: 'navigate',
      targetUrl: url,
    });
    
    if (!response.ok) {
      throw new Error(`Navigation failed: ${response.error}`);
    }
    
    this.currentUrl = response.url || url;
    this.currentTitle = response.title || '';
    this.targetId = response.targetId;
    
    // Get snapshot after navigation
    return this.getState();
  }
  
  /**
   * Click an element
   */
  async click(selector: string): Promise<Observation> {
    const response = await this.invoker({
      action: 'act',
      targetId: this.targetId,
      request: {
        kind: 'click',
        ref: selector,
      },
    });
    
    if (!response.ok) {
      throw new Error(`Click failed: ${response.error}`);
    }
    
    return this.getState();
  }
  
  /**
   * Type text into an element
   */
  async type(selector: string, text: string): Promise<Observation> {
    const response = await this.invoker({
      action: 'act',
      targetId: this.targetId,
      request: {
        kind: 'type',
        ref: selector,
        text,
      },
    });
    
    if (!response.ok) {
      throw new Error(`Type failed: ${response.error}`);
    }
    
    return this.getState();
  }
  
  /**
   * Scroll the page
   */
  async scroll(direction: 'up' | 'down', amount?: number): Promise<Observation> {
    const response = await this.invoker({
      action: 'act',
      targetId: this.targetId,
      request: {
        kind: 'scroll',
        // OpenClaw uses key presses for scroll
        key: direction === 'down' ? 'PageDown' : 'PageUp',
      },
    });
    
    if (!response.ok) {
      throw new Error(`Scroll failed: ${response.error}`);
    }
    
    return this.getState();
  }
  
  /**
   * Extract content from the page
   */
  async extract(selectors: Record<string, string>): Promise<{ observation: Observation; data: Record<string, unknown> }> {
    // Get fresh snapshot
    const observation = await this.getState();
    
    // Extract data from snapshot text
    // In a full implementation, this would parse the accessibility tree
    const data: Record<string, unknown> = {};
    
    for (const [name, selector] of Object.entries(selectors)) {
      // Find element in observation
      const element = observation.elements?.find(e => 
        e.selector === selector || e.attributes?.['data-ref'] === selector
      );
      
      if (element) {
        data[name] = element.text || element.attributes?.value || null;
      } else {
        data[name] = null;
      }
    }
    
    return { observation, data };
  }
  
  /**
   * Take a screenshot
   */
  async screenshot(): Promise<{ observation: Observation; image: string }> {
    const response = await this.invoker({
      action: 'screenshot',
      targetId: this.targetId,
    });
    
    if (!response.ok) {
      throw new Error(`Screenshot failed: ${response.error}`);
    }
    
    const observation = await this.getState();
    
    // Response should include base64 image
    return {
      observation,
      image: (response as any).image || '',
    };
  }
  
  /**
   * Wait for a condition or time
   */
  async wait(ms: number): Promise<Observation> {
    const response = await this.invoker({
      action: 'act',
      targetId: this.targetId,
      request: {
        kind: 'wait',
        timeMs: ms,
      },
    });
    
    if (!response.ok) {
      throw new Error(`Wait failed: ${response.error}`);
    }
    
    return this.getState();
  }
  
  /**
   * Get current page state
   */
  async getState(): Promise<Observation> {
    const response = await this.invoker({
      action: 'snapshot',
      targetId: this.targetId,
      compact: true,
    });
    
    if (!response.ok) {
      throw new Error(`Snapshot failed: ${response.error}`);
    }
    
    // Update current state
    if (response.url) this.currentUrl = response.url;
    if (response.title) this.currentTitle = response.title;
    if (response.targetId) this.targetId = response.targetId;
    
    // Parse snapshot into elements
    const elements = this.parseSnapshot(response.snapshot || '');
    
    return {
      url: this.currentUrl,
      title: this.currentTitle,
      visibleText: response.snapshot,
      elements,
      timestamp: Date.now(),
    };
  }
  
  /**
   * Parse OpenClaw snapshot format into elements
   * 
   * Format: ref=N role "label" [attributes]
   */
  private parseSnapshot(snapshot: string): ObservedElement[] {
    const elements: ObservedElement[] = [];
    const lines = snapshot.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('ref=')) continue;
      
      // Parse: ref=N role "label" attributes
      const refMatch = trimmed.match(/^ref=(\S+)\s+(\w+)\s+"([^"]*)"(.*)$/);
      if (!refMatch) continue;
      
      const [, ref, role, label, rest] = refMatch;
      
      // Parse attributes from rest
      const attributes: Record<string, string> = {
        'data-ref': ref,
        role,
      };
      
      // Check for common attributes
      if (rest.includes('disabled')) attributes.disabled = 'true';
      if (rest.includes('required')) attributes.required = 'true';
      if (rest.includes('focusable')) attributes.focusable = 'true';
      if (rest.includes('focused')) attributes.focused = 'true';
      
      elements.push({
        selector: `[data-ref="${ref}"]`,
        tagName: this.roleToTag(role),
        text: label,
        attributes,
        visible: true,
      });
    }
    
    return elements;
  }
  
  /**
   * Map ARIA role to HTML tag (approximate)
   */
  private roleToTag(role: string): string {
    const mapping: Record<string, string> = {
      button: 'button',
      link: 'a',
      textbox: 'input',
      checkbox: 'input',
      radio: 'input',
      combobox: 'select',
      listbox: 'select',
      heading: 'h2',
      img: 'img',
      list: 'ul',
      listitem: 'li',
      navigation: 'nav',
      main: 'main',
      article: 'article',
      form: 'form',
    };
    
    return mapping[role.toLowerCase()] || 'div';
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create adapter from OpenClaw tool context
 * 
 * Usage in plugin:
 * ```
 * const adapter = createAdapterFromContext(async (req) => {
 *   return await browserTool.invoke(req);
 * });
 * ```
 */
export function createAdapterFromInvoker(invoker: BrowserToolInvoker): OpenClawBrowserAdapter {
  return new OpenClawBrowserAdapter(invoker);
}
