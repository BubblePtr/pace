# Pace — Agent Instructions

> Canonical agent instructions for this repo, shared across all runtimes (Pi, Claude Code, and any other agent). `CLAUDE.md` imports this file — edit here, not there. Only rules specific to this repository live here; general contribution rules are in `CONTRIBUTING.md`.

Pace is the desktop workbench for the [Pi coding agent](https://pi.dev). Pi is the only engine: each root Session runs in its own isolated process that embeds the Pi SDK directly (`SessionProcessDriver` + `pi-sdk-driver`; the earlier CLI RPC driver was removed in ADR-0041). Pi's local session log is the source of truth and Pace persists only projections of Pi's event stream. The shell is Electron (`utilityProcess` backend + React renderer, ADR-0013). Product scope lives in `README.md`; feature PRDs and decision records live under `.scratch/<feature>/PRD.md`.

## Orientation

The "Architecture" section of `README.md` is the canonical map: the event-pipeline diagram, the "Where things live" table (which file to edit for which concern), and the step-by-step prompt flow. Consult it before searching the codebase. Backend modules mirror that map: `packages/backend/src/{drivers,gateway,persistence,workspace}` with `service.ts` as the composition root.

Process conventions, each documented in its own file:

- Issues and PRDs: `docs/agents/issue-tracker.md`
- Triage labels: `docs/agents/triage-labels.md`
- Domain docs (`CONTEXT.md` + `docs/adr/`): `docs/agents/domain.md`
- Branches, PRs, stacks, commit messages: `CONTRIBUTING.md`

## Verification

Before opening a PR, `bun run typecheck`, `bun run test` and `bun run build` must be green (see "Development and verification" in `README.md` for the full command list, including E2E and packaging).

## Design system discipline

The dev-only `/design` page (`apps/desktop/src/pages/design.tsx`) is the living registry of the design system.

- **Astryx first.** Before building or extending any UI, run `bunx astryx build "<idea>"` and study the returned kit. Hand-roll a component only when Astryx has no equivalent. Full CLI workflow and styling rules: `apps/desktop/AGENTS.md`.
- **Reusable components live in `apps/desktop/src/shared/ui/` — nowhere else.** Page-level composition stays in `pages/`; if a piece of UI becomes reusable across pages, extract it to `shared/ui/` first.
- **Every component added to `shared/ui/` MUST be registered on the Design page in the same PR**, showing all variants and typical states (loading / empty / error where applicable). Changing a component's variants means updating its Design page entry in the same PR.
- Tokens go through the semantic bridge in `apps/desktop/src/app/styles.css` (`--foreground`, `--primary`, …) or raw Astryx first-level tokens — never hard-coded colors, radii or spacing.
- Usage rules live in `docs/design/` (`README.md` is the entry); the ledger of self-built components is `docs/self-built-ui.md`. Update the matching file in the same PR when a component's variants or a token changes.

## UI intent picker

The dev-only picker (`Cmd/Ctrl+Shift+X`) maps clicked elements to CONTEXT.md region terms via the binding table `apps/desktop/src/dev/ui-intent/regions.ts`. **When you rename or move a region-level component, update that table in the same PR** — a test asserts every bound term still exists as a `**Term**:` heading in CONTEXT.md.

## Worktrees

- **Worktrees never check out `main`.** Git refuses to check out one branch in two worktrees, so a worktree holding `main` locks the primary checkout onto a detached HEAD. Every worktree gets its own `feat/` / `fix/` / `chore/` branch; when it needs current trunk code, `git fetch` and branch from `origin/main`.
- **Worktree cleanup does no checkout.** After the PR merges, run `git worktree remove <path>` then `git branch -d <branch>`; switching to `main` and pulling belongs to the primary checkout only.

## Runtime gotchas

- **`bun run dev` writes to `~/.pace-dev`, not `~/.pace`.** The unpackaged app defaults its data directory to a sibling so a dev instance never mixes with the installed app's sessions; `PACE_DATA_DIR` overrides it (`PIGUI_DATA_DIR` is a one-minor-version alias). Details: `docs/dogfooding.md`.
- **Never exercise the terminal pty driver (`packages/backend/src/drivers/terminal.ts`) under the Bun runtime** (`bun script.ts`, `bun -e`). Bun's Node-API support breaks `@lydell/node-pty`: the pty spawns, then its fd dies early (`ioctl(2) failed, EBADF`). Production runs the backend in Electron's Node via `utilityProcess` and vitest runs on Node, so this only affects one-off debug scripts: run those with `node script.mjs`.
