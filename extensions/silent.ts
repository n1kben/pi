/**
 * Silent transcript: only your prompts and the answers.
 *
 * Pi draws one row per tool call, a block per thinking run, and a turn for every
 * assistant message that hands off to tools. Silent mode drops all three while
 * they render, so the transcript keeps the prompts and the answers. Pi's own
 * working indicator still carries progress, and the notices Pi writes into the
 * chat (errors, warnings, status lines) stay readable.
 *
 * Those components belong to Pi, not to this extension, so hiding them is a patch
 * on their `render` that installs once per process. The patch looks its behavior
 * and the on/off flag up through `globalThis`, because Pi's classes outlive a
 * `/reload` while this module does not: a wrapper closing over its own copy would
 * keep running the first version until Pi restarts.
 *
 * Toggle with ctrl+' or /silent [on|off]. Every session starts silent.
 */
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { MouseRegion, Spacer } from "@mariozechner/pi-tui";

const SHORTCUT = "ctrl+'";
const WIDGET_KEY = "silent";
const STATE_KEY = Symbol.for("pi.silent.state");
const BEHAVIOR_KEY = Symbol.for("pi.silent.behavior");
const PATCH_KEY = Symbol.for("pi.silent.patch");

type Render = (width: number) => string[];
type Override = (component: any, width: number, render: Render) => string[];

interface State {
	enabled: boolean;
	/** Pi's TUI, reached through the widget factory; repaints the transcript on a toggle. */
	tui?: { requestRender(): void };
}

function state(): State {
	const holder = globalThis as typeof globalThis & { [STATE_KEY]?: State };
	holder[STATE_KEY] ??= { enabled: true };
	return holder[STATE_KEY];
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
 * A turn that hands off to tools is progress, not an answer, however it ended.
 * Pi sets this from the message's content, so it holds for stored turns too.
 */
function isIntermediate(component: { hasToolCalls?: unknown }): boolean {
	return component.hasToolCalls === true;
}

/**
 * An assistant turn is built from three kinds of children: each thinking run is a
 * MouseRegion (the block, or its "Thinking…" label) followed by a spacer, the
 * answer is Markdown, and an error, abort, or truncation notice is a spacer plus a
 * plain Text. Only the thinking is dropped, and only for this one render: the
 * children are restored in `finally`, so the component and its message stay
 * untouched and reappear in full once the mode is off.
 */
function answerOnly(
	component: { hasToolCalls?: unknown; contentContainer?: { children?: unknown[] } },
	width: number,
	render: Render,
): string[] {
	// A turn that hands off to tools is progress: the work itself stays hidden, so
	// its narration would describe rows that are no longer there.
	if (isIntermediate(component)) return [];

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

function silent(): boolean {
	return state().enabled;
}

const behavior: Record<"tools" | "assistant", Override> = {
	tools: (_component, width, render) => (silent() ? [] : render(width)),
	assistant: (component, width, render) => (silent() ? answerOnly(component, width, render) : render(width)),
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

function parseArgument(args: string, current: boolean): boolean | undefined {
	const argument = args.trim().toLowerCase();
	if (argument === "") return !current;
	if (argument === "on") return true;
	if (argument === "off") return false;
	return undefined;
}

export default function (pi: ExtensionAPI) {
	publish();
	patch(ToolExecutionComponent?.prototype, "tools");
	patch(AssistantMessageComponent?.prototype, "assistant");

	const apply = (enabled: boolean): void => {
		state().enabled = enabled;
		// Nothing in the chat indicates the mode: it shows its own absence.
		state().tui?.requestRender();
	};

	pi.registerCommand("silent", {
		description: `(${SHORTCUT}) Show only your prompts and the answers`,
		handler: async (args, ctx) => {
			const enabled = parseArgument(args, silent());
			if (enabled === undefined) {
				ctx.ui.notify("Usage: /silent [on|off]", "warning");
				return;
			}
			apply(enabled);
		},
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Toggle the silent transcript",
		handler: () => apply(!silent()),
	});

	pi.on("session_start", (_event, ctx) => {
		state().enabled = true;
		if (ctx.mode !== "tui") return;
		// An invisible widget is the extension API's way to reach Pi's TUI, which is
		// what repaints the rows already in the transcript when the mode changes.
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			state().tui = tui;
			return { render: () => [], invalidate() {} };
		}, { placement: "belowEditor" });
	});
}
