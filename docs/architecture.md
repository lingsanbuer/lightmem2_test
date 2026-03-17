# Architecture Notes

## Scope Strategy

- Phase 1: single-session execution path only.
- Phase 2: cross-session memory/retrieval via `MemoryGraph` interface.

This keeps cache prefix stability predictable while we validate token savings.

## State and Persistence

EcoClaw persistence is filesystem-first and lives under:

- `<stateDir>/ecoclaw/sessions/<sessionId>/turns.jsonl`
- `<stateDir>/ecoclaw/sessions/<sessionId>/meta.json`
- `<stateDir>/ecoclaw/sessions/<sessionId>/summary.json`

`stateDir` is provided by the connector host (OpenClaw plugin runtime).
In development harnesses, we can point it to a local `.state` folder.

## Cache vs Experience Reuse Trade-off

Experience reuse may alter system prompt and reduce prompt-cache hit rate.
To balance this, use a versioned prompt profile strategy:

- Stable base prefix: rarely changed policy and tool contract.
- Experience layer: separately versioned profile blocks.
- Volatile layer: current task and tool outputs.

Any experience update should bump profile version only for affected sessions/workloads.

## Future Modules

- `module-memory-graph`: cross-session memory linking and retrieval.
- `module-profile-manager`: system prompt profile lifecycle and rollout.
- `module-subagent-policy`: task-aware delegation policies.
