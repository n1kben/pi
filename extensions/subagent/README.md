# Subagent

Vendored copy of [badlogic/pi-subagent](https://github.com/badlogic/pi-subagent)
(`@earendil-works/pi-subagent`), upstream commit `4fc1fe5`, 2026-09-30.

It runs subagents as separate `pi` processes in their own tmux session and
provides the `subagent` CLI plus the `/subagent` command and status widget.

## Layout

- `index.ts` — pi extension: `/subagent` attach command, status widget, and the
  child-side control bridge (inbox polling, session name sync).
- `subagent.ts` — `subagent` CLI (`spawn`, `status`, `rename`, `send`, `wait`,
  `stop`, `list`). Linked to `~/.pi/agent/bin/subagent` by `install.sh`.
- `shared.ts` — run metadata, launch, and session-transcript helpers.
- `skills/subagent/SKILL.md` — skill contributed via `resources_discover`.

Requires `tmux` and Node.js 22.19 or newer.

## Local changes from upstream

- 2-space indentation to match this repo; no behavior changes.
- Dropped the upstream `package.json` (pi discovers `extensions/subagent/index.ts`
  directly; the CLI symlink is handled by `install.sh` instead of a package
  `bin` entry).
- This README replaces the upstream one.

Keep diffs against upstream small so updates stay easy: pull upstream into a
checkout, copy the four files, and re-run the indentation step.
