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
`keybindings.json`, and `settings.json` into `~/.pi/agent`. Run
`make uninstall` to remove the links.

## Layout

- `extensions/` — pi extensions (TypeScript, loaded directly by pi).
- `prompts/` — prompt templates.
- `themes/` — custom themes.
- `keybindings.json` — keybindings.
- `settings.json` — pi settings.

## Note on settings

`settings.json` is written to by pi itself (e.g. `lastChangelogVersion`), so it
will show up as modified from time to time. Commit the meaningful changes.
