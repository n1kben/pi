#!/usr/bin/env bash
# Link (or unlink) this pi config into ~/.pi/agent.
# Works without make; `make install` just delegates here.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HOME}/.pi/agent"
FILES=(extensions prompts themes keybindings.json settings.json models.json)
# CLIs exposed on PATH; ~/.pi/agent/bin is expected to be on PATH already.
BINS=(extensions/subagent/subagent.ts)

link() {
	local status=0
	mkdir -p "$DEST"
	for f in "${FILES[@]}"; do
		local target="$DEST/$f"
		if [ -e "$target" ] && [ ! -L "$target" ]; then
			echo "refusing to replace $target (not a symlink); move it aside first" >&2
			status=1
			continue
		fi
		ln -sfn "$DIR/$f" "$target"
		echo "linked $target -> $DIR/$f"
	done
	mkdir -p "$DEST/bin"
	for f in "${BINS[@]}"; do
		local target="$DEST/bin/$(basename "${f%.ts}")"
		if [ -e "$target" ] && [ ! -L "$target" ]; then
			echo "refusing to replace $target (not a symlink); move it aside first" >&2
			status=1
			continue
		fi
		ln -sfn "$DIR/$f" "$target"
		echo "linked $target -> $DIR/$f"
	done
	return $status
}

unlink() {
	for f in "${FILES[@]}"; do
		local target="$DEST/$f"
		if [ -L "$target" ]; then
			rm -f "$target"
			echo "removed $target"
		fi
	done
	for f in "${BINS[@]}"; do
		local target="$DEST/bin/$(basename "${f%.ts}")"
		if [ -L "$target" ]; then
			rm -f "$target"
			echo "removed $target"
		fi
	done
	rmdir "$DEST/bin" 2>/dev/null || true
}

case "${1:-install}" in
	install) link ;;
	uninstall) unlink ;;
	*) echo "usage: $0 [install|uninstall]" >&2; exit 2 ;;
esac
