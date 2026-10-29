/**
 * Two transcripts: clean by default, everything on ctrl+o.
 *
 * Pi draws one row per tool call, a block per thinking run, and a turn for every
 * assistant message that hands off to tools. Clean keeps only the prompts and the
 * answers: those rows are dropped while they render, and Pi's own working
 * indicator is hidden too, because the terminal reports activity on its own
 * (Ghostty's tab indicator, via Pi's terminal.showTerminalProgress). The notices
 * Pi writes into the chat (errors, warnings, status lines) stay readable.
 *
 * ctrl+o is Pi's expand-everything key, so the mode is read from that same
 * expansion state instead of a state of its own: collapsed renders clean, expanded
 * renders every row inline, expanded, and with its thinking showing.
 *
 * Those components belong to Pi, not to this extension, so the clean rendering is
 * a patch on their `render` that installs once per process. The patch looks its
 * behavior and the expansion state up through `globalThis`, because Pi's classes
 * outlive a `/reload` while this module does not: a wrapper closing over its own
 * copy would keep running the first version until Pi restarts.
 */
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { MouseRegion, Spacer } from "@mariozechner/pi-tui";

const STATE_KEY = Symbol.for("pi.silent.state");
const BEHAVIOR_KEY = Symbol.for("pi.silent.behavior");
const PATCH_KEY = Symbol.for("pi.silent.patch");

type Render = (width: number) => string[];
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

const behavior: Record<"tools" | "assistant", Override> = {
	tools: (_component, width, render) => (clean() ? [] : render(width)),
	assistant: (component, width, render) => {
		if (clean()) return answerOnly(component, width, render);
		revealThinking(component);
		return render(width);
	},
};

/** Route every patched render through the copy of this module loaded most recently. */
function publish(): void {
	(globalThis as typeof globalThis & { [BEHAVIOR_KEY]?: typeof behavior })[BEHAVIOR_KEY] = behavior;
}

function patch(prototype: object | undefined, key: keyof typeof behavior): boolean {
	if (!prototype || typeof (prototype as { render?: unknown }).render !== "function") return false;
	// Checked as an own property: a component inheriting render() from a shared base
	// still needs its own wrapper, and a re-evaluating /reload must not stack one.
	if (Object.hasOwn(prototype, PATCH_KEY)) return true;
	const original = (prototype as { render: Render }).render;
	(prototype as { render: Render }).render = function (this: unknown, width: number): string[] {
		const override = (globalThis as typeof globalThis & { [BEHAVIOR_KEY]?: typeof behavior })[BEHAVIOR_KEY]?.[key];
		return override ? override(this, width, (next) => original.call(this, next)) : original.call(this, width);
	};
	Object.defineProperty(prototype, PATCH_KEY, { value: true });
	return true;
}

export default function (pi: ExtensionAPI) {
	publish();
	patch(ToolExecutionComponent?.prototype, "tools");
	patch(AssistantMessageComponent?.prototype, "assistant");

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// ctrl+o already repaints the transcript, so reading its state needs no hook
		// of its own. The terminal reports activity; a second indicator in the
		// prompt would only repeat it.
		state().expanded = () => ctx.ui.getToolsExpanded();
		ctx.ui.setWorkingVisible(false);
	});
}
