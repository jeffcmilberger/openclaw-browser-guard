# OpenClaw Browser Guard - Security Plan

## Overview

Browser Guard provides **architectural-level protection** for OpenClaw's web tools (`web_fetch`, `browser`) against prompt injection attacks. It combines ideas from two key papers:

1. **ceLLMate** (arXiv:2512.12594) - Browser-level sandboxing with agent sitemaps and policy enforcement
2. **CaML for CUAs** (arXiv:2601.09923) - Single-shot planning with control flow integrity

The core insight: **browsing is inherently multi-turn and observation-heavy**, which breaks the dual-LLM isolation pattern. The solution is to generate a complete execution plan *before* observing any untrusted content.

## Threat Model

### What We're Protecting Against
- **Prompt injection via web content**: Malicious instructions embedded in fetched pages
- **Data exfiltration**: Tricking the agent into sending sensitive data to attacker-controlled endpoints
- **Confused deputy**: Using the agent's credentials/capabilities for unintended actions
- **Branch steering**: Manipulating UI/content to trigger unintended but "valid" execution paths

### Attacker Capabilities
- Can control content on arbitrary websites
- Can inject content into user-controlled sites (comments, emails, etc.)
- Cannot control the user's local system or OpenClaw itself
- Cannot modify the trusted planner's instructions

## Architecture

Combines two complementary approaches:
1. **HTTP-level filtering** (from ceLLMate) - Controls what requests can be made
2. **Action-level orchestration** (from CaML-CUA) - Controls what UI actions to perform

```
┌─────────────────────────────────────────────────────────────────┐
│                     TRUSTED ZONE                                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   Task       │───▶│   Planner    │───▶│  Execution   │      │
│  │   Parser     │    │   (LLM)      │    │    DAG       │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│         │                   │                   │               │
│         ▼                   ▼                   ▼               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   Policy     │    │    HTTP      │    │   Executor   │      │
│  │   Engine     │◀──▶│   Filter     │◀──▶│   Runtime    │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│         │                   │                   │               │
└─────────│───────────────────│───────────────────│───────────────┘
          │                   │                   │
          │         ISOLATION BOUNDARY            │
          │                   │                   │
┌─────────│───────────────────│───────────────────│───────────────┐
│         ▼                   ▼                   ▼               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   Site       │    │   Network    │    │   Browser    │      │
│  │   Policies   │    │   Requests   │    │   DOM/UI     │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│                            │                    │               │
│                            ▼                    ▼               │
│                      ┌──────────────────────────────┐          │
│                      │         Web Content          │          │
│                      └──────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

### Defense Layers

1. **Predicted Allowlist** (HTTP Filter)
   - Domains derived from task intent
   - Blocks requests to unexpected domains

2. **Sitemap Matching** (HTTP Filter)
   - Maps URLs + methods + bodies to semantic actions
   - Based on ceLLMate's sitemap format

3. **Policy Rules** (HTTP Filter)
   - Allow/deny/allow_public per semantic action
   - Site-authored and task-derived

4. **Execution DAG** (Action Orchestration)
   - Pre-computed action graph with branches
   - No deviation from planned paths

5. **Branch Steering Guard** (Action Orchestration)
   - Validates observations match expectations
   - Detects UI manipulation attempts

## Core Components

### 1. Task Parser
Converts natural language user request into structured intent.

```typescript
interface BrowsingIntent {
  goal: string;                    // What the user wants to achieve
  allowedDomains: string[];        // Domains we're allowed to visit
  allowedActions: ActionType[];    // click, scroll, type, extract, etc.
  sensitiveData: string[];         // Data that must not leave the system
  maxDepth: number;                // Max navigation depth
  timeout: number;                 // Max execution time
}
```

**Example:**
- User: "Find the price of the RTX 5090 on newegg"
- Intent: `{ goal: "extract_price", allowedDomains: ["newegg.com"], allowedActions: ["navigate", "scroll", "extract"], sensitiveData: [], maxDepth: 3 }`

### 2. Single-Shot Planner
Generates complete execution DAG with conditional branches BEFORE any browsing.

```typescript
interface ExecutionDAG {
  nodes: ExecutionNode[];
  edges: ConditionalEdge[];
  entryPoint: string;
  exitPoints: string[];
}

interface ExecutionNode {
  id: string;
  action: BrowserAction;
  expectedOutcomes: string[];      // What we expect to see
  extractionTargets?: string[];    // Data to extract
  securityConstraints: Constraint[];
}

interface ConditionalEdge {
  from: string;
  to: string;
  condition: BranchCondition;      // e.g., "if login_required", "if captcha_present"
}
```

**Key insight**: The planner must enumerate *all possible branches* upfront:
- Page not found → exit with error
- Login required → abort (don't enter credentials)
- Captcha → abort or notify user
- Expected content found → extract and continue
- Unexpected redirect → abort

### 3. Policy Engine
Enforces constraints at multiple levels.

#### Mandatory Policies (Site-Authored)
Sites can declare policies via headers or meta tags:
```html
<meta name="ai-agent-policy" content="no-form-submit, no-purchase, read-only">
```

#### Derived Policies (Task-Based)
Auto-generated from user intent:
- "Search for X" → read-only, no form submission except search
- "Buy X" → allow purchase flow, but confirm before payment
- "Check my email" → allow login, but no forwarding/deletion

#### Static Policies (Hardcoded)
- Never submit payment without explicit user confirmation
- Never enter credentials on non-HTTPS sites
- Never download executables
- Never navigate to known-malicious domains

### 4. Executor Runtime
Executes the DAG, with observations feeding back ONLY at predefined branch points.

```typescript
class SecureExecutor {
  async execute(dag: ExecutionDAG, policy: Policy): Promise<ExecutionResult> {
    let currentNode = dag.entryPoint;
    
    while (!dag.exitPoints.includes(currentNode)) {
      const node = dag.nodes.find(n => n.id === currentNode);
      
      // Execute action (in untrusted zone)
      const observation = await this.executeAction(node.action);
      
      // Branch steering detection
      if (!this.validateObservation(observation, node.expectedOutcomes)) {
        return { status: 'aborted', reason: 'unexpected_state' };
      }
      
      // Policy check
      if (!policy.allows(node.action, observation)) {
        return { status: 'blocked', reason: 'policy_violation' };
      }
      
      // Determine next node via predefined branches only
      currentNode = this.selectBranch(dag.edges, currentNode, observation);
    }
    
    return { status: 'complete', data: this.collectedData };
  }
}
```

### 5. Branch Steering Guard
Detects attempts to manipulate execution flow.

**Attack example**: Attacker creates a page that looks like "search results" but is actually a phishing form. The plan says "if search_results → extract prices" but the attacker's page triggers that branch while being something else entirely.

**Defense**: 
- Validate DOM structure matches expected patterns
- Check URL hasn't been redirected unexpectedly  
- Verify page content hashes against known-good patterns (for critical sites)
- Use visual similarity detection for high-security flows

## Integration with OpenClaw

### web_fetch Integration
```typescript
// Before (unsafe)
const result = await web_fetch({ url: userProvidedUrl });
// Content flows directly to LLM - injection possible!

// After (guarded)
const intent = await taskParser.parse(userRequest);
const plan = await planner.generatePlan(intent);
const policy = await policyEngine.derive(intent);

if (!policy.allowsIntent(intent)) {
  return { error: 'Policy violation', details: policy.violations };
}

const result = await secureExecutor.execute(plan, policy);
// Only structured, validated data reaches the LLM
```

### browser Tool Integration
```typescript
// Hook into OpenClaw's browser tool
export const browserGuardHook: ToolHook = {
  name: 'browser-guard',
  
  async beforeToolCall(call: ToolCall): Promise<ToolCallDecision> {
    if (call.tool !== 'browser') return { allow: true };
    
    // Parse user's browsing intent
    const intent = await parseIntent(call.context);
    
    // Generate secure execution plan
    const plan = await generatePlan(intent);
    
    // Replace free-form browsing with guided execution
    return {
      allow: true,
      transform: {
        tool: 'browser_guard_execute',
        params: { plan, originalIntent: intent }
      }
    };
  }
};
```

## Implementation Phases

### Phase 1: Core Framework (Week 1)
- [ ] Task parser for common browsing intents
- [ ] Basic execution DAG structure
- [ ] Policy engine with static policies
- [ ] Integration hooks for web_fetch

### Phase 2: Single-Shot Planner (Week 2)
- [ ] LLM-based plan generation
- [ ] Branch enumeration for common scenarios
- [ ] Plan validation and safety checking
- [ ] Timeout and depth limiting

### Phase 3: Browser Integration (Week 3)
- [ ] Hook into OpenClaw browser tool
- [ ] DOM observation and validation
- [ ] Branch steering detection
- [ ] Visual similarity checks (optional)

### Phase 4: Policy Ecosystem (Week 4)
- [ ] Site-authored policy parsing
- [ ] Task-derived policy generation
- [ ] Policy composition and conflict resolution
- [ ] User override mechanisms

### Phase 5: Hardening (Ongoing)
- [ ] Adversarial testing
- [ ] Performance optimization
- [ ] Caching of plans for common tasks
- [ ] Community policy contributions

## Security Guarantees

### What We Guarantee
1. **Control Flow Integrity**: Execution follows only predefined paths
2. **No Unauthorized Exfiltration**: Sensitive data cannot leave via browser actions
3. **Policy Enforcement**: Site and user policies are respected
4. **Fail-Secure**: Unknown states result in abort, not continuation

### What We Don't Guarantee
1. **Perfect intent parsing**: User must verify generated plan matches intent
2. **Protection against all side channels**: Timing attacks, etc. out of scope
3. **Protection if plan is wrong**: Garbage in, garbage out

## References

1. Meng et al. "ceLLMate: Sandboxing Browser AI Agents" (arXiv:2512.12594)
2. Foerster et al. "CaMeLs Can Use Computers Too" (arXiv:2601.09923)  
3. Debenedetti et al. "AgentDojo: Benchmarking AI Agents" (2024)
4. Original CaML paper (arXiv:2503.18813)

## License

Apache 2.0 (same as OpenClaw)
