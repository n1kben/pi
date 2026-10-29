# Pi

Personal configuration for [pi](https://github.com/badlogic/pi-mono): extensions,
prompts, themes, keybindings, and settings. Kept out of the dotfiles repo so pi
config can evolve independently.

## Setup

Clone anywhere, then symlink into `~/.pi/agent`:

```bash
git clone <repository-url> ~/Developer/n1kben/pi
cd ~/Developer/n1kben/pi
make install
```

`make install` symlinks `extensions/`, `prompts/`, `themes/`,
`keybindings.json`, `settings.json`, and `models.json` into `~/.pi/agent`, and
links the `subagent` CLI into `~/.pi/agent/bin` (expected to be on `PATH`). On
machines without make, run `./install.sh install` directly. `make uninstall`
(or `./install.sh uninstall`) removes the links.

## Layout

- `extensions/` — pi extensions (TypeScript, loaded directly by pi).
  `extensions/subagent/` is a vendored copy of [badlogic/pi-subagent](https://github.com/badlogic/pi-subagent),
  including its `subagent` CLI and skill; see its README for local changes.
- `prompts/` — empty, kept for local prompt templates (contents not tracked).
- `themes/` — custom themes.
- `keybindings.json` — keybindings.
- `settings.json` — pi settings.
- `models.json` — provider/model overrides (currently OpenRouter provider
  routing: prefer Nebius, then Crusoe, sorted by latency).

## Note on settings

`settings.json` is written to by pi itself (e.g. `lastChangelogVersion`), so it
will show up as modified from time to time. Commit the meaningful changes.
