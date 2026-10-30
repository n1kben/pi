/**
 * Working message from the tool call in flight.
 *
 * Pi appends whatever working message is set after its spinner, and the tool call itself is
 * the only honest account of what is happening that costs nothing: it announces its name
 * and arguments before it runs. Phrases turn those into words (see phrases.ts); this file
 * is only about when the line changes.
 *
 * Between calls there is nothing to report but the model writing, so the line says
 * "Thinking". A tool call can be over in milliseconds, which would flash its phrase too
 * fast to read, so changes are spaced: a burst of fast calls is sampled, one phrase per
 * window and always the newest, and the last phrase holds the line for a moment before
 * "Thinking" takes it back. A nested call would only make the line flicker while the
 * outer tool is still the thing the user can see, so only top-level calls are reported.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe } from "./phrases.ts";

/** One line, wide enough for a path or a command, narrow enough for a terminal. */
const MAX_CHARS = 48;
/** A tool that finishes sooner than this would never be readable. */
const DWELL_MS = 2000;
/** Two changes closer together than this are not worth the second one. */
const COALESCE_MS = 400;
const THINKING = "Thinking";

function clip(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > MAX_CHARS ? `${line.slice(0, MAX_CHARS - 1)}…` : line;
}

export default function (pi: ExtensionAPI) {
	let shown: string | undefined;
	/** When the line last changed, so the next change can be held back. */
	let shownAt = 0;
	/** The newest message asked for, which a held-back change will write. */
	let wanted: { message: string; ctx: ExtensionContext } | undefined;
	let owed: ReturnType<typeof setTimeout> | undefined;
	/** Set when the line owes a phrase a turn before it may go back to "Thinking". */
	let owedBeforeThinking = false;

	const settle = (ctx: ExtensionContext, message: string): void => {
		shown = message;
		shownAt = Date.now();
		ctx.ui.setWorkingMessage(message);
	};

	const flush = (): void => {
		owed = undefined;
		if (wanted && wanted.message !== shown) settle(wanted.ctx, wanted.message);
		if (!owedBeforeThinking) return;
		owedBeforeThinking = false;
		if (wanted) show(wanted.ctx, THINKING);
	};

	/**
	 * Pi redraws on every set, so an unchanged message is not worth one. A change that
	 * comes too soon is not dropped but held back, and the newest one written when the
	 * wait is over: a burst of fast calls samples the phrases instead of flashing each.
	 */
	const show = (ctx: ExtensionContext, message: string): void => {
		const next = clip(message);
		// A phrase held back has not been on screen yet: it takes its turn first, then the
		// line goes back to waiting. Dropping it would hide every short tool.
		if (next === THINKING && owed && wanted && wanted.message !== THINKING) {
			owedBeforeThinking = true;
			return;
		}
		owedBeforeThinking = false;
		wanted = { message: next, ctx };
		if (owed) {
			clearTimeout(owed);
			owed = undefined;
		}
		if (next === shown) return;

		// A phrasing that follows a tool keeps the line for the full dwell; any other
		// change only has to be far enough from the one before it. The wait is measured
		// from the last change, so a burst of calls keeps sampling one phrase at a time
		// instead of pushing the write back with each of them.
		const minimum = next === THINKING ? DWELL_MS : COALESCE_MS;
		const left = minimum - (Date.now() - shownAt);
		if (left <= 0) settle(ctx, next);
		else owed = setTimeout(flush, left);
	};

	pi.on("session_start", () => {
		// A fresh session carries no message of ours, so the last one cannot be reused.
		shown = undefined;
	});

	pi.on("session_shutdown", () => {
		// A message owed to a finished session would only keep the process waiting for it.
		if (owed) clearTimeout(owed);
		owed = undefined;
	});

	pi.on("turn_start", (_event, ctx) => {
		if (ctx.mode === "tui") show(ctx, THINKING);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.mode !== "tui" || event.parentToolCallId) return;
		show(ctx, describe(event.toolName, event.args));
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx.mode !== "tui" || event.parentToolCallId) return;
		show(ctx, THINKING);
	});
}
