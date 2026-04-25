# Plugin Semantic Grouping

## Purpose

This document records the semantic grouping of the current plugin runtime.
It is a planning document for future cleanup and regrouping. It does not imply
that files should be physically moved immediately.

The current codebase is already in a workable state after the large `index.ts`
split. The next step is to align mental model and naming before any second
round of directory reorganization.

## Group 1: Request-Time Transforms

These modules mutate or filter payloads close to request/response boundaries.
They are local transforms, not long-term history management.

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

## Group 2: History Lifecycle

These modules define how transcript-derived state is assembled, persisted,
rewritten, and evicted across a long-running session timeline.

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
- task/session binding
- task-aware eviction

## Group 3: Recovery

These modules implement the recovery protocol around archived content and
explicit recovery tool behavior.

Files:

- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/recovery/common.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/recovery/protocol.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/recovery/tool.ts`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/execution/archive-recovery/index.ts`

Typical responsibility:

- recovery markers
- archive reference resolution
- memory fault recovery tool behavior

## Group 4: Runtime Glue

These modules wire the runtime together. They should stay thin and should not
grow new domain logic without a strong reason.

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

## Cleanup Guidance

The next cleanup pass should prefer:

1. deleting stale docs and scripts
2. rewriting outdated entrypoint documentation
3. keeping physical file moves minimal until naming and boundaries are stable

Do not start a second large directory reorganization until:

- `TokenPilot` branding is settled
- runtime identifiers that must remain compatible are explicitly listed
- benchmark integration is stable again after the current continual fixes
