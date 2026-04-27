# Plugin Semantic Grouping

## Purpose

This document records the semantic grouping of the current plugin runtime.
It reflects the **current landed structure**, not a speculative future layout.

The main regroup is now complete:

- semantic facades exist under `src/context-stack/`
- request preprocessing, page-out, page-in, and integration all have physical
  modules under that tree
- `index.ts` is now primarily a composition root

## Context Management Stack

The plugin runtime is better understood as a three-part context management
stack, plus one integration layer.

### 1. Request Preprocessing

These modules act before content becomes durable context/history.

They mutate or filter payloads close to request/response boundaries and improve
prompt locality before the long-term context stack is touched.

Files:

- `packages/openclaw-plugin/src/context-stack/request-preprocessing/stable-prefix.ts`
- `packages/openclaw-plugin/src/context-stack/request-preprocessing/before-call-reduction.ts`
- `packages/openclaw-plugin/src/context-stack/request-preprocessing/after-call-reduction.ts`
- `packages/openclaw-plugin/src/context-stack/request-preprocessing/reduction-context.ts`
- `packages/openclaw-plugin/src/context-stack/request-preprocessing/reduction-helpers.ts`
- `packages/openclaw-plugin/src/context-stack/request-preprocessing/tool-results-persist.ts`
- `packages/openclaw-plugin/src/context-stack/request-preprocessing/root-prompt-stabilizer.ts`

Typical responsibility:

- stable prefix reuse
- request-time reduction
- response-time reduction
- tool-result ingress shaping
- pre-context payload hygiene

### 2. Page Out

These modules define how transcript-derived state is assembled, persisted,
rewritten, and eventually paged out of the active context timeline.

Files:

- `packages/openclaw-plugin/src/context-stack/page-out/transcript-sync.ts`
- `packages/openclaw-plugin/src/context-stack/page-out/canonical-state.ts`
- `packages/openclaw-plugin/src/context-stack/page-out/canonical-anchors.ts`
- `packages/openclaw-plugin/src/context-stack/page-out/canonical-rewrite.ts`
- `packages/openclaw-plugin/src/context-stack/page-out/canonical-eviction.ts`
- `packages/openclaw-plugin/src/session/topology.ts`
- `packages/openclaw-plugin/src/session/turn-bindings.ts`

Typical responsibility:

- canonical state maintenance
- transcript-to-history sync
- session and turn binding
- task-aware eviction
- stub/reference creation for cold history

### 3. Page In

These modules implement how paged-out content is reintroduced when it becomes
useful again.

Today this mainly means archive lookup + recovery-tool rehydration. In the
future this bucket can also absorb semantic retrieval / selective memory
reinjection paths.

Files:

- `packages/openclaw-plugin/src/context-stack/page-in/recovery-common.ts`
- `packages/openclaw-plugin/src/context-stack/page-in/recovery-protocol.ts`
- `packages/openclaw-plugin/src/context-stack/page-in/recovery-tool.ts`
- `packages/openclaw-plugin/src/execution/archive-recovery/index.ts`

Typical responsibility:

- recovery markers
- archive reference resolution
- memory fault recovery tool behavior
- future selective recall / semantic retrieve paths

## Integration Layer

These modules wire the runtime together. They are not a first-class context
management strategy and should stay thin.

Files:

- `packages/openclaw-plugin/src/context-stack/integration/config.ts`
- `packages/openclaw-plugin/src/context-stack/integration/context-engine.ts`
- `packages/openclaw-plugin/src/context-stack/integration/runtime-helpers.ts`
- `packages/openclaw-plugin/src/context-stack/integration/runtime-register.ts`
- `packages/openclaw-plugin/src/context-stack/integration/proxy-runtime.ts`
- `packages/openclaw-plugin/src/context-stack/integration/proxy-provider.ts`
- `packages/openclaw-plugin/src/context-stack/integration/trace-hooks.ts`
- `packages/openclaw-plugin/src/proxy/upstream.ts`
- `packages/openclaw-plugin/src/index.ts`

Typical responsibility:

- config normalization
- hook registration
- provider wiring
- gateway/runtime orchestration
- context stack bootstrap

## Current Status

The regroup goal is now mostly achieved:

- old `canonical/`, `recovery/`, `runtime/`, and most `proxy/` file locations are gone
- semantic file ownership is visible in the directory tree
- remaining old-location outlier is primarily `src/proxy/upstream.ts`

The next cleanup passes should be smaller:

1. remove empty legacy directories
2. keep `src/index.ts` thin
3. decide whether `src/proxy/upstream.ts` should also move under `integration/`
