# Pi agent configuration installer — location-independent.
# Computes its own path, so `make install` works no matter where the repo is
# cloned. Symlinks the config into ~/.pi/agent.

DIR  := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
DEST := $(HOME)/.pi/agent
LINKS := extensions prompts themes keybindings.json settings.json

.PHONY: install uninstall help

help: ## Show available targets
	@grep -E '^[a-z][a-zA-Z-]*:.*##' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/'

install: ## Symlink the config into ~/.pi/agent
	@mkdir -p $(DEST)
	@for f in $(LINKS); do ln -sfn "$(DIR)/$$f" "$(DEST)/$$f"; done

uninstall: ## Remove the symlinks this repo created
	@for f in $(LINKS); do rm -f "$(DEST)/$$f"; done
