# Experiments Consolidation Plan

This document defines how benchmark and evaluation assets should move into the
main repository under `experiments/`.

The current benchmark harness is still maintained outside this repo. The goal
here is to define a safe merge path, not to perform the merge immediately.

## Goal

Target structure:

```text
experiments/
  dataset/
  scripts/
  results/
  save/
  docs/
```

The merged layout should support:

- baseline runs
- method runs
- continual vs isolated settings
- saved benchmark artifacts
- plotting/reporting scripts

## Design Principles

1. preserve current runnable experiment paths until the new layout is validated
2. separate reusable harness code from method-specific entrypoints
3. keep historical result paths interpretable
4. do not mix benchmark logic into plugin package directories

## What Belongs Under `experiments/`

### Should move

- dataset-specific benchmark code
- benchmark wrapper scripts
- result directories
- saved run artifacts
- plotting/comparison helpers
- runtime-profile docs that are benchmark-owned

### Should stay outside `experiments/`

- plugin runtime code
- plugin release/install helpers
- generic architecture docs that describe the system itself

## Proposed Layout

```text
experiments/
  README.md
  dataset/
    pinchbench/
      scripts/
      prompts/
      tasks/
  scripts/
    run_baseline_*.sh
    run_tokenpilot_*.sh
    compare_*.sh
  results/
    raw/
    processed/
  save/
    continual/
    isolated/
  docs/
    runtime-profile.md
    benchmark-notes.md
```

## Migration Phases

### Phase 1: Mirror Without Breaking Existing Harness

Create the target directory layout in the main repo, but keep the current
benchmark harness authoritative.

Tasks:

1. add top-level `experiments/README.md`
2. define target subdirectories
3. document ownership boundaries

### Phase 2: Move Documentation and Shared Profiles First

Move the easiest benchmark-owned assets first:

- runtime profile docs
- benchmark-specific README content
- plotting usage notes

These are low-risk because they do not change executable paths.

### Phase 3: Move Wrapper Scripts

Move or mirror shell entrypoints:

- baseline entrypoints
- method entrypoints
- plotting entrypoints

Rules:

- preserve old script names as compatibility wrappers initially
- prefer moving generic harness logic before method-specific wrappers

### Phase 4: Move Dataset Harness Code

Only after the above is stable:

- move dataset-side Python helpers
- move benchmark driver scripts
- revalidate all main run modes

### Phase 5: Freeze External Harness Or Convert To Thin Mirror

At the end of the transition:

- either archive the old benchmark repo
- or keep it as a thin compatibility mirror

## Naming Policy Inside `experiments/`

Do not over-brand reusable harness code.

### Use neutral names for

- shared runtime profile
- generic benchmark runner
- plotting/comparison helpers
- dataset driver utilities

Examples:

- `run_pinchbench_baseline.sh`
- `run_pinchbench_method.sh`
- `runtime-profile.md`

### Keep method names only where method-specific behavior exists

Examples:

- `run_tokenpilot_eviction_full.sh`
- `results/raw/pinchbench/tokenpilot/...`

This keeps future method additions from forcing another framework rename.

## Validation Checklist Before Real Merge

Before moving executable benchmark code, confirm:

1. continual baseline full still runs
2. continual method full still runs
3. isolated baseline/method paths still run
4. `task_22` style explicit `new_session` still grades correctly
5. judge setup no longer mutates global runtime config
6. path-sensitive scripts no longer assume the old sibling-repo layout

## Immediate Next Step

The next practical step is:

1. keep the current external benchmark harness as the live source of truth
2. use this plan to classify which files are benchmark-owned
3. start by moving docs/profile assets before any executable harness code
