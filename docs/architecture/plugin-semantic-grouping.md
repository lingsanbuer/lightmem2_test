# Plugin Semantic Grouping

## Purpose

This document records the semantic grouping of the current plugin runtime.
It is a planning document for future cleanup and regrouping. It does not imply
that files should be physically moved immediately.

The current codebase is already in a workable state after the large `index.ts`
split. The next step is to align mental model and naming before any second
round of directory reorganization.

## Context Management Stack

The plugin runtime is better understood as a three-part context management
stack, plus one integration layer.

### 1. Request Preprocessing

These modules act before content becomes durable context/history.

They mutate or filter payloads close to request/response boundaries and improve
prompt locality before the long-term context stack is touched.

Files:

- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/proxy/stable-prefix.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/proxy/before-call-reduction.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/proxy/after-call-reduction.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/proxy/reduction-context.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/proxy/reduction-helpers.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/tool-results/persist.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/root-prompt-stabilizer.ts`

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

- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/canonical/state.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/canonical/anchors.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/canonical/rewrite.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/canonical/eviction.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/transcript/sync.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/session/topology.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/session/turn-bindings.ts`

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

- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/recovery/common.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/recovery/protocol.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/recovery/tool.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/execution/archive-recovery/index.ts`

Typical responsibility:

- recovery markers
- archive reference resolution
- memory fault recovery tool behavior
- future selective recall / semantic retrieve paths

## Integration Layer

These modules wire the runtime together. They are not a first-class context
management strategy and should stay thin.

Files:

- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/config.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/context-engine.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/runtime/helpers.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/runtime/register.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/proxy/runtime.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/proxy/provider.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/proxy/upstream.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/index.ts`

Typical responsibility:

- config normalization
- hook registration
- provider wiring
- gateway/runtime orchestration
- context stack bootstrap

## Cleanup Guidance

The next cleanup pass should prefer:

1. deleting stale docs and scripts
2. rewriting outdated entrypoint documentation
3. keeping physical file moves minimal until naming and boundaries are stable

Do not start a second large directory reorganization until:

- `TokenPilot` branding is settled
- runtime identifiers that must remain compatible are explicitly listed
- benchmark integration is stable again after the current continual fixes
