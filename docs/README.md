# Documentation

## Architecture

- [Overview](architecture/overview.md) - 3-layer architecture, key distinctions
- [Canonical Design](architecture/canonical-design.md) - Transcript/canonical/eviction design
- [Plugin Semantic Grouping](architecture/plugin-semantic-grouping.md) - Current semantic buckets for plugin modules
- [Plugin Script Inventory](architecture/plugin-script-inventory.md) - Status of plugin-side helper scripts

## Plans

- [Eviction Implementation Plan](plans/eviction-plan.md) - Task-level eviction implementation
- [Reduction Plan](plans/reduction-plan.md) - Reduction layer refactor plan

## Experiments

- [Estimator Mode Comparison](experiments/estimator-mode.md) - Sliding window vs completed summary modes
- [Observations Source](../exp/) - Raw observation files from experiments

## Bug Reports

- [Bug Reports Index](bug-reports/index.md) - All documented bugs with severity, root cause, resolution

## Run Guide

- [Run Guide](run-guide.md) - Plugin development workflow, runtime sync, verification, pre-run checklist, common issues

## Scripts

- [Smoke Test Gateway](scripts/smoke_isolated_gateway.sh) - Isolated gateway smoke test

## Deleted/Archived

Old documentation from `EcoClaw_read_before_exe/`:
- `bug.txt` - consolidated into `bug-reports/index.md`
- `notice.txt` - integrated into `run-guide.md` (operational notes) and `bug-reports/index.md`
- `plan.txt` - older phase plan, removed after later architecture refactors
- `progresss.txt` - older status log, removed after later continual/eviction refactors
- `reduction_plan.txt` - moved to `plans/reduction-plan.md`
- `SupervisorAgent.txt` - archived, reference only (not current architecture)
- `task_plan.txt` - moved to `plans/eviction-plan.md`
- `PICHAY.txt` - old design reference, removed from the active docs index
- `notice_background.txt` - archived (background context, not current design)
