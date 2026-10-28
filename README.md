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
`keybindings.json`, and `settings.json` into `~/.pi/agent`. On machines without
make, run `./install.sh install` directly. `make uninstall` (or
`./install.sh uninstall`) removes the links.

## Layout

- `extensions/` — pi extensions (TypeScript, loaded directly by pi).
- `prompts/` — empty, kept for local prompt templates (contents not tracked).
- `themes/` — custom themes.
- `keybindings.json` — keybindings.
- `settings.json` — pi settings.

## Note on settings

`settings.json` is written to by pi itself (e.g. `lastChangelogVersion`), so it
will show up as modified from time to time. Commit the meaningful changes.
