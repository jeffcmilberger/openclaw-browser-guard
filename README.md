# OpenClaw Browser Guard 🛡️🌐

Architectural-level security for browser-using AI agents. Protects OpenClaw's `web_fetch` and `browser` tools against prompt injection attacks.

## The Problem

Browser agents are uniquely vulnerable to prompt injection:
- They **must observe untrusted content** (web pages)
- They need **multi-turn interaction** to navigate
- Dual-LLM isolation breaks when the agent needs continuous feedback

## The Solution

**Single-Shot Planning**: Generate a complete execution plan *before* seeing any web content.

```
User Request → Task Parser → Planner (trusted) → Execution DAG
                                                       ↓
                                              Secure Executor
                                                       ↓
                                              Web (untrusted)
```

The executor only follows predefined paths. Unexpected states = abort.

## Key Features

- **Control Flow Integrity**: Execution follows only predefined branches
- **Policy Enforcement**: Site-authored + task-derived + static policies
- **Branch Steering Detection**: Catches attempts to manipulate valid paths
- **Fail-Secure**: Unknown states abort, never continue

## Quick Start

```bash
# Install
npm install openclaw-browser-guard

# Add to OpenClaw config
openclaw config set plugins.entries.browser-guard.enabled true
```

## How It Works

1. **Parse Intent**: Convert user request to structured browsing intent
2. **Generate Plan**: Create execution DAG with all possible branches
3. **Derive Policy**: Auto-generate constraints from task + site policies
4. **Execute Securely**: Follow plan, validate at each step, abort on anomalies

See [PLAN.md](./PLAN.md) for detailed architecture.

## Papers

Based on research from:
- [ceLLMate: Sandboxing Browser AI Agents](https://arxiv.org/abs/2512.12594)
- [CaMeLs Can Use Computers Too](https://arxiv.org/abs/2601.09923)

## Status

🚧 **Early Development** - Not ready for production use.

## License

Apache 2.0
