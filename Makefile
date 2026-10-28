# Pi agent configuration installer — location-independent.
# Thin wrapper around install.sh (the VPS has no make), so `make install` and
# `./install.sh install` do the same thing.

.PHONY: install uninstall help

help: ## Show available targets
	@grep -E '^[a-z][a-zA-Z-]*:.*##' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/'

install: ## Symlink the config into ~/.pi/agent
	@./install.sh install

uninstall: ## Remove the symlinks this repo created
	@./install.sh uninstall
