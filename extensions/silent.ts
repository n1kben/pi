/**
 * Two transcripts: clean by default, everything on ctrl+o.
 *
 * Pi draws one row per tool call, a block per thinking run, and a turn for every
 * assistant message that hands off to tools. Clean keeps the prompts, the answers, and
 * the calls that change files: an edit or a write keeps its call line plus how many
 * lines it added and removed, because that summary is the part the reader checks, and
 * every other call is the work itself. The notices Pi writes into the chat (errors,
 * warnings, status lines) stay readable.
 *
 * ctrl+o is Pi's expand-everything key, so the mode is read from that same
 * expansion state instead of a state of its own: collapsed renders clean, expanded
 * renders every row inline, expanded, and with its thinking showing.
 *
 * Those components belong to Pi, not to this extension. Hiding rows is a patch on
 * `ToolExecutionComponent.render` that installs once per process; the file-change
 * summary comes from `registerToolRenderer`, which is Pi's own seam for drawing a
 * tool call, so the header and path stay exactly as Pi formats them. The patch looks its
 * behavior and the expansion state up through `globalThis`, because Pi's classes
 * outlive a `/reload` while this module does not: a wrapper closing over its own
 * copy would keep running the first version until Pi restarts.
 */
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolRenderers,
} from "@mariozechner/pi-coding-agent";
import { Box, Container, getCapabilities, hyperlink, MouseRegion, Spacer, Text, type Component } from "@mariozechner/pi-tui";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STATE_KEY = Symbol.for("pi.silent.state");
const BEHAVIOR_KEY = Symbol.for("pi.silent.behavior");
const PATCH_KEY = Symbol.for("pi.silent.patch");
/** Calls whose rows clean mode keeps: they change files, so the reader checks them. */
const WRITE_TOOLS = new Set(["write", "edit"]);

type Render = (width: number) => string[];
type Theme = ExtensionContext["ui"]["theme"];
type Counts = { added: number; removed: number };
type Override = (component: any, width: number, render: Render) => string[];

/** A turn's children as Pi builds them, plus the two members this file reads. */
interface AssistantLike {
	hasToolCalls?: unknown;
	hideThinkingBlock?: unknown;
	setHideThinkingBlock?(hide: boolean): void;
	contentContainer?: { children?: unknown[] };
}

interface State {
	/** Pi's expansion state, read at render time; absent outside the TUI. */
	expanded?: () => boolean;
}

function state(): State {
	const holder = globalThis as typeof globalThis & { [STATE_KEY]?: State };
	holder[STATE_KEY] ??= {};
	return holder[STATE_KEY];
}

/**
 * Clean unless the reader asked ctrl+o for everything. A context Pi has since
 * replaced throws, and an unreadable mode must not swallow the transcript.
 */
function clean(): boolean {
	try {
		return state().expanded?.() !== true;
	} catch {
		return true;
	}
}

/**
 * Inside Pi an extension imports the same pi-tui copy Pi uses. A second copy (a
 * development checkout, say) still builds the same class, so a matching name
 * identifies it there.
 */
function isKind(child: unknown, kind: abstract new (...args: any[]) => unknown): boolean {
	return child instanceof kind
		|| (typeof child === "object" && child !== null && child.constructor?.name === kind.name);
}

/**
 * An assistant turn is built from three kinds of children: each thinking run is a
 * MouseRegion (the block, or its "Thinking…" label) followed by a spacer, the
 * answer is Markdown, and an error, abort, or truncation notice is a spacer plus a
 * plain Text. Only the thinking is dropped, and only for this one render: the
 * children are restored in `finally`, so the component and its message stay
 * untouched and reappear in full once the mode is expanded.
 */
function answerOnly(component: AssistantLike, width: number, render: Render): string[] {
	// A turn that hands off to tools is progress: the work itself is hidden, so its
	// narration would describe rows that are no longer there.
	if (component.hasToolCalls === true) return [];

	const container = component.contentContainer;
	const children = container?.children;
	if (!container || !Array.isArray(children)) return render(width);

	const kept: unknown[] = [];
	let afterThinking = false;
	for (const child of children) {
		if (isKind(child, MouseRegion)) {
			afterThinking = true;
			continue;
		}
		if (afterThinking && isKind(child, Spacer)) {
			afterThinking = false;
			continue;
		}
		afterThinking = false;
		kept.push(child);
	}
	// Most turns have no thinking to drop; skip the swap and the repaint bookkeeping.
	if (kept.length === children.length) return render(width);
	// A turn that was only thinking would otherwise leave its leading blank line.
	if (kept.every((child) => isKind(child, Spacer))) return [];

	container.children = kept;
	try {
		return render(width);
	} finally {
		container.children = children;
	}
}

/**
 * Expanded means everything, thinking included. Pi reads its visibility only while
 * rebuilding a turn, so flip the flag and let the rebuild happen before the render
 * that follows — the same call Pi makes when the setting changes.
 */
function revealThinking(component: AssistantLike): void {
	if (component.hideThinkingBlock !== true) return;
	component.setHideThinkingBlock?.(false);
}

const behavior = {
	// Clean hides every call but the ones that changed a file.
	tools: (component, width, render) => (clean() && !WRITE_TOOLS.has(component?.toolName) ? [] : render(width)),
	assistant: (component, width, render) => {
		if (clean()) return answerOnly(component, width, render);
		revealThinking(component);
		return render(width);
	},
} satisfies Record<string, Override>;

/**
 * Lines an edit adds and removes, taken from the arguments it is applying. The edit
 * tool only matches `oldText`, so the diff is exactly those lines: no need to wait for
 * the result or to read the file to know the size of the change.
 */
function editCounts(args: any): Counts | undefined {
	const edits: unknown[] = Array.isArray(args?.edits) ? args.edits : [args];
	let added = 0;
	let removed = 0;
	for (const edit of edits as Array<Record<string, unknown> | undefined>) {
		if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") return undefined;
		added += edit.newText.split("\n").length;
		removed += edit.oldText.split("\n").length;
	}
	return { added, removed };
}

/** A write has no old text to remove; the lines it is about to write are the change. */
function writeCounts(args: any): Counts | undefined {
	if (typeof args?.content !== "string") return undefined;
	const content = args.content.replace(/\n$/, "");
	return { added: content === "" ? 0 : content.split("\n").length, removed: 0 };
}

function countText(counts: Counts, theme: Theme): string {
	const parts: string[] = [];
	if (counts.added > 0) parts.push(theme.fg("toolDiffAdded", `+${counts.added}`));
	if (counts.removed > 0) parts.push(theme.fg("toolDiffRemoved", `-${counts.removed}`));
	return parts.join(" ");
}

type RowContext = {
	cwd: string;
	isPartial: boolean;
	isError: boolean;
	outputPad: number;
};

/**
 * The header Pi draws for an edit or a write: the tool name and the path, built the
 * same way `renderToolPath` builds it. It is rebuilt here instead of reusing Pi's call
 * row because that row pads every line to the render width and closes its own
 * background — appending to it wraps the counts onto a row of their own.
 * Pi draws edit rows in the "self" shell, where the row owns its background and
 * padding, so those are reproduced here; write rows get them from Pi's own shell.
 */
function headerRow(
	toolName: string,
	args: any,
	counts: Counts | undefined,
	theme: Theme,
	context: RowContext,
	shell: "default" | "self" | undefined,
): Component {
	const raw = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : "";
	const home = homedir();
	let path = raw ? theme.fg("accent", raw.startsWith(home) ? `~${raw.slice(home.length)}` : raw) : theme.fg("toolOutput", "...");
	if (raw && getCapabilities().hyperlinks) path = hyperlink(path, pathToFileURL(resolve(context.cwd, raw)).href);
	const title = theme.fg("toolTitle", theme.bold(toolName));
	const stat = counts ? countText(counts, theme) : "";
	const text = new Text(stat ? `${title} ${path} ${stat}` : `${title} ${path}`, 0, 0);
	if (shell !== "self") return text;

	const background = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
	const box = new Box(context.outputPad || 1, 1, (line: string) => theme.bg(background, line));
	box.addChild(text);
	return box;
}

/** Which counts a row summarises; both tools change files, nothing else uses this. */
function fileChangeCounts(toolName: string, args: unknown): Counts | undefined {
	if (toolName === "edit") return editCounts(args);
	if (toolName === "write") return writeCounts(args);
	return undefined;
}

/** Route every patched render through the copy of this module loaded most recently. */
function publish(): void {
	(globalThis as typeof globalThis & { [BEHAVIOR_KEY]?: typeof behavior })[BEHAVIOR_KEY] = behavior;
}

/** Wrap one prototype's `render`, once per process. */
function patch(target: object | undefined, key: keyof typeof behavior): void {
	if (!target || typeof (target as { render?: unknown }).render !== "function") return;
	// Checked as an own property: a component inheriting render() from a shared base
	// still needs its own wrapper, and a re-evaluating /reload must not stack one.
	if (Object.hasOwn(target, PATCH_KEY)) return;
	const original = (target as { render: Render }).render;
	(target as { render: Render }).render = function (this: unknown, width: number): string[] {
		const override = (globalThis as typeof globalThis & { [BEHAVIOR_KEY]?: typeof behavior })[BEHAVIOR_KEY]?.[key];
		return override ? override(this, width, (next) => original.call(this, next)) : original.call(this, width);
	};
	Object.defineProperty(target, PATCH_KEY, { value: true });
}

export default function (pi: ExtensionAPI) {
	publish();
	patch(ToolExecutionComponent?.prototype, "tools");
	patch(AssistantMessageComponent?.prototype, "assistant");

	// Collapsed shows a file change as its call line plus how many lines moved. Expanded
	// defers to Pi's own renderers, so ctrl+o still shows the full diff or file. A failed
	// edit counts nothing: nothing moved, and the error text follows the line.
	pi.registerToolRenderer((toolName, next) => {
		if (!WRITE_TOOLS.has(toolName)) return undefined;
		const base = next();
		if (!base?.renderCall || !base.renderResult) return undefined;
		const renderers: ToolRenderers = {
			renderShell: base.renderShell,
			renderCall: (args, theme, context) => {
				if (context.expanded) return base.renderCall?.(args, theme, context) as any;
				const counts = context.isError ? undefined : fileChangeCounts(toolName, args);
				return headerRow(toolName, args, counts, theme, context, base.renderShell);
			},
			// Pi's edit renderer rebuilds the call row with the settled diff as a side
			// effect of drawing the result. Skipping it leaves the summary in place.
			renderResult: (result, options, theme, context) =>
				!context.expanded && !context.isError
					? new Container()
					: (base.renderResult?.(result, options, theme, context) as any),
		};
		return renderers;
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		state().expanded = () => ctx.ui.getToolsExpanded();
	});
}
