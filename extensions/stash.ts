import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

type StashedPrompt = {
  id: string;
  text: string;
  createdAt: number;
};

type StashState = {
  version?: number;
  prompts: StashedPrompt[];
};

const CUSTOM_TYPE = "stash-state";
const LEGACY_CUSTOM_TYPE = "prompt-stash-state";
const STATUS_ID = "stash";
const WIDGET_ID = "stash";
const STATE_VERSION = 1;

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function firstLine(text: string) {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}

function labelFor(prompt: StashedPrompt, index: number) {
  const preview = firstLine(prompt.text).replace(/\s+/g, " ").slice(0, 80) || "(empty prompt)";
  const lines = prompt.text.split(/\r?\n/).length;
  const suffix = lines > 1 ? ` · ${lines} lines` : "";
  return `${index + 1}. ${preview}${suffix}`;
}

function truncate(text: string, width: number) {
  if (width <= 0) return "";
  return text.length > width ? text.slice(0, Math.max(0, width - 1)) + "…" : text;
}

function renderLine(text: string, width: number, style?: (text: string) => string) {
  const line = truncate(text, width);
  return style ? style(line) : line;
}

export default function (pi: ExtensionAPI) {
  let prompts: StashedPrompt[] = [];

  function stateFile(ctx: ExtensionContext) {
    const sessionFile = ctx.sessionManager.getSessionFile();
    return sessionFile ? `${sessionFile}.stash.json` : undefined;
  }

  function legacyStateFile(ctx: ExtensionContext) {
    const sessionFile = ctx.sessionManager.getSessionFile();
    return sessionFile ? `${sessionFile}.prompt-stash.json` : undefined;
  }

  function parseState(state: Partial<StashState> | undefined) {
    if (!Array.isArray(state?.prompts)) return [];
    return state.prompts.filter((p): p is StashedPrompt =>
      !!p && typeof p.id === "string" && typeof p.text === "string" && typeof p.createdAt === "number",
    );
  }

  function persist(ctx: ExtensionContext) {
    const file = stateFile(ctx);
    if (!file) return;

    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, prompts } satisfies StashState, null, 2));
    renameSync(tmp, file);
  }

  function updateBadge(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    ctx.ui.setStatus(STATUS_ID, undefined);
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }

  function restore(ctx: ExtensionContext) {
    prompts = [];

    const file = stateFile(ctx);
    if (file) {
      try {
        prompts = parseState(JSON.parse(readFileSync(file, "utf8")) as Partial<StashState>);
        updateBadge(ctx);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          ctx.ui.notify(`Could not read stash: ${(error as Error).message}`, "warning");
        }
      }
    }

    const legacyFile = legacyStateFile(ctx);
    if (legacyFile) {
      try {
        prompts = parseState(JSON.parse(readFileSync(legacyFile, "utf8")) as Partial<StashState>);
        if (prompts.length > 0) persist(ctx);
        updateBadge(ctx);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          ctx.ui.notify(`Could not read legacy stash: ${(error as Error).message}`, "warning");
        }
      }
    }

    // One-time migration/fallback for old stash state that was stored as branch-local custom entries.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || (entry.customType !== CUSTOM_TYPE && entry.customType !== LEGACY_CUSTOM_TYPE)) continue;
      prompts = parseState(entry.data as Partial<StashState> | undefined);
    }
    if (prompts.length > 0) persist(ctx);
    updateBadge(ctx);
  }

  async function stashText(ctx: ExtensionContext, text: string) {
    if (!text.trim()) {
      ctx.ui.notify("Nothing to stash", "warning");
      return;
    }

    prompts.unshift({ id: makeId(), text, createdAt: Date.now() });
    persist(ctx);
    ctx.ui.setEditorText("");
    updateBadge(ctx);
    ctx.ui.notify(`Stashed prompt (${prompts.length} total)`, "info");
  }

  async function manageStash(ctx: ExtensionContext) {
    if (prompts.length === 0) {
      ctx.ui.notify("Stash is empty", "info");
      return;
    }

    type Action = "apply" | "pop" | "drop" | "drop-all" | "cancel";
    const result = await ctx.ui.custom<{ action: Action; index?: number }>((tui, theme, _keybindings, done) => {
      let selected = 0;

      function clamp() {
        selected = Math.max(0, Math.min(selected, prompts.length - 1));
      }

      return {
        render(width: number) {
          clamp();
          const lines = [
            renderLine("Stash", width, (text) => theme.fg("accent", theme.bold(text))),
            renderLine("↑↓ select · enter pop · a apply · d drop · D drop all · esc cancel", width, (text) => theme.fg("dim", text)),
            "",
          ];

          prompts.forEach((prompt, index) => {
            const label = truncate(labelFor(prompt, index), Math.max(0, width - 2));
            if (index === selected) {
              lines.push(theme.fg("accent", `› ${label}`));
            } else {
              lines.push(`  ${label}`);
            }
          });

          return lines;
        },
        invalidate() {},
        handleInput(data: string) {
          if (matchesKey(data, "up")) {
            selected--;
            clamp();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "down")) {
            selected++;
            clamp();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "enter")) return done({ action: "pop", index: selected });
          if (data === "a") return done({ action: "apply", index: selected });
          if (data === "d") return done({ action: "drop", index: selected });
          if (data === "D") return done({ action: "drop-all" });
          if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return done({ action: "cancel" });
        },
      };
    });

    if (!result || result.action === "cancel") return;

    if (result.action === "drop-all") {
      const ok = await ctx.ui.confirm("Drop all stashed prompts?", `Remove ${prompts.length} stashed prompt(s)?`);
      if (!ok) return;
      prompts = [];
      persist(ctx);
      updateBadge(ctx);
      ctx.ui.notify("Stash cleared", "info");
      return;
    }

    const index = result.index ?? -1;
    const prompt = prompts[index];
    if (!prompt) return;

    if (result.action === "apply" || result.action === "pop") {
      ctx.ui.setEditorText(prompt.text);
    }

    if (result.action === "pop" || result.action === "drop") {
      prompts.splice(index, 1);
      persist(ctx);
      updateBadge(ctx);
      ctx.ui.notify(result.action === "pop" ? "Popped prompt from stash" : "Dropped prompt", "info");
    }
  }

  pi.on("session_start", (_event, ctx) => {
    restore(ctx);

    if (ctx.mode === "tui") {
      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        return new class extends CustomEditor {
          render(width: number): string[] {
            if (prompts.length === 0 || width < 5) return super.render(width);

            const badge = ` ${prompts.length} `;
            const gap = " ";
            const reserveWidth = badge.length + gap.length * 2;
            const editorWidth = Math.max(1, width - reserveWidth);
            const lines = super.render(editorWidth);
            const targetLine = lines.length > 2 ? 1 : 0;

            const borderContinuation = theme.borderColor("─".repeat(reserveWidth));
            const bottomBorderLine = Math.min(lines.length - 1, targetLine + 1 + this.getLines().length);

            return lines.map((line, index) => {
              if (index === 0 || index === bottomBorderLine) return `${line}${borderContinuation}`;
              if (index === targetLine) return `${line}${gap}\x1b[7m${badge}\x1b[0m${gap}`;
              return `${line}${" ".repeat(reserveWidth)}`;
            });
          }

          handleInput(data: string): void {
            if (data === "\x13") {
              const text = this.getText();
              void (text.trim() ? stashText(ctx, text) : manageStash(ctx));
              return;
            }
            super.handleInput(data);
          }
        }(tui, theme, keybindings);
      });
    }
  });

  pi.registerCommand("stash", {
    description: "Stash current editor/args, or manage stash when editor is empty",
    handler: async (args, ctx) => {
      const text = args.trim() || ctx.ui.getEditorText();
      if (text.trim()) await stashText(ctx, text);
      else await manageStash(ctx);
    },
  });


  // Ctrl+S is handled by the custom editor above. Do not also register it as
  // an extension shortcut: pi uses Ctrl+S for built-in save actions in other
  // views, and registering it here triggers an extension shortcut conflict.
  pi.registerShortcut("ctrl+shift+o", {
    description: "Manage stashed prompts",
    handler: async (ctx) => {
      await manageStash(ctx);
    },
  });
}
