/**
 * Working message from the tool call in flight.
 *
 * Pi appends whatever working message is set after its spinner. The only honest source
 * of "what is happening" that costs nothing is the tool call itself: every tool
 * announces its name and arguments before it runs, so a small verb table turns that into
 * a phrase and anything unrecognised is shown as the command or path it was given.
 *
 * Between calls there is nothing to report but the model writing, so the line says
 * "Thinking". A tool call can be over in milliseconds, which would flash its phrase too
 * fast to read, so changes are spaced: a burst of fast calls is sampled, one phrase per
 * window and always the newest, and the last phrase holds the line for a moment before
 * "Thinking" takes it back. A nested call would only make the line flicker while the
 * outer tool is still the thing the user can see, so only top-level calls are reported.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

/** One line, wide enough for a path or a command, narrow enough for a terminal. */
const MAX_CHARS = 48;
/** A tool that finishes sooner than this would never be readable. */
const DWELL_MS = 2000;
/** Two changes closer together than this are not worth the second one. */
const COALESCE_MS = 400;
const THINKING = "Thinking";

/** Programs whose job reads better than their name. */
const PROGRAMS: Record<string, string> = {
	bun: "Running a script",
	cargo: "Building",
	cat: "Reading",
	clang: "Compiling",
	cp: "Copying files",
	curl: "Fetching",
	deno: "Running a script",
	docker: "Running docker",
	gcc: "Compiling",
	gh: "Talking to GitHub",
	git: "Running git",
	go: "Building",
	grep: "Searching",
	head: "Reading",
	jest: "Running tests",
	jq: "Reshaping json",
	ls: "Listing",
	make: "Building",
	mkdir: "Creating a directory",
	mv: "Moving files",
	node: "Running a script",
	npm: "Running npm",
	python: "Running a script",
	python3: "Running a script",
	pytest: "Running tests",
	rg: "Searching",
	rm: "Removing files",
	rustc: "Compiling",
	scp: "Copying files",
	sed: "Editing text",
	ssh: "Connecting",
	tail: "Reading",
	tree: "Listing",
	tsc: "Typechecking",
	vitest: "Running tests",
	wget: "Fetching",
};

/** Programs whose argument says more than their name. */
const SUBCOMMANDS: Record<string, Record<string, string>> = {
	bun: { install: "Installing", run: "Running a script", test: "Running tests" },
	cargo: { build: "Building", test: "Running tests", run: "Running a script" },
	gh: { api: "Talking to GitHub", issue: "Talking to GitHub", pr: "Talking to GitHub", run: "Talking to GitHub" },
	git: {
		add: "Staging",
		blame: "Reading git blame",
		checkout: "Switching branches",
		clone: "Cloning",
		commit: "Committing",
		diff: "Reading the diff",
		fetch: "Fetching",
		log: "Reading the log",
		merge: "Merging",
		pull: "Pulling",
		push: "Pushing",
		rebase: "Rebasing",
		show: "Reading a commit",
		stash: "Stashing",
		status: "Reading the git status",
		switch: "Switching branches",
	},
	npm: { ci: "Installing", exec: "Running a script", install: "Installing", run: "Running a script", test: "Running tests" },
	pnpm: { install: "Installing", run: "Running a script", test: "Running tests" },
	yarn: { install: "Installing", run: "Running a script", test: "Running tests" },
};

/** Programs that take a source and a destination, where the pair says more than the verb. */
const TRANSFER: Record<string, string> = {
	cp: "Copying",
	ln: "Linking",
	mv: "Moving",
	rsync: "Syncing",
	scp: "Copying",
};

/** Anything that names a credential is reduced to its program, never echoed. */
const SECRET = /token|secret|password|bearer|api[-_]?key/i;

function clip(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > MAX_CHARS ? `${line.slice(0, MAX_CHARS - 1)}…` : line;
}

/** The last two segments: enough to know the file, short enough to fit. */
function shortPath(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || path;
}

function host(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** The name a path ends with: the part that says what the file is. */
function baseName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** "Copying a.ts to tmp": the two paths, not just the fact that files moved. */
function transfer(verb: string, args: readonly string[]): string | undefined {
	const paths = args.filter((token) => !token.startsWith("-"));
	if (paths.length < 2) return undefined;
	// The source is a file name, the destination a place: two segments say which tmp.
	const destination = shortPath(paths[paths.length - 1]!);
	const sources = paths.slice(0, -1);
	if (sources.length > 1) return `${verb} ${sources.length} files to ${destination}`;
	const source = baseName(sources[0]!);
	// The same name on both ends (a log pulled down, a symlink beside its target) does
	// not need the destination spelled out again.
	return source === baseName(destination) ? `${verb} ${source}` : `${verb} ${source} to ${destination}`;
}

/** A shell command as a phrase, from its program and subcommand. */
function summarize(command: string): string {
	const line = command.split("\n").find((part) => part.trim()) ?? "";
	// Leading `VAR=value` and a `cd … &&` prologue say nothing about the work itself.
	const stripped = line
		.replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")
		.replace(/^cd\s+\S+\s*&&\s*/, "")
		.trim();
	const [head = "", ...rest] = stripped.split(/\s+/);
	if (!head) return "Running a command";

	const program = head.split(/[\\/]/).pop() ?? head;
	const sub = rest.find((token) => !token.startsWith("-"));
	const moved = TRANSFER[program] ? transfer(TRANSFER[program]!, rest) : undefined;
	if (moved) return moved;
	const known = (sub && SUBCOMMANDS[program]?.[sub]) || PROGRAMS[program];
	if (known) return known;
	if (SECRET.test(stripped) || rest.some((token) => token.includes("="))) return `Running ${program}`;
	return sub ? `Running ${program} ${sub}` : `Running ${program}`;
}

/** What the tool is doing, from its name and the arguments it was given. */
function describe(toolName: string, args: unknown): string {
	const input = (args ?? {}) as Record<string, unknown>;
	const text = (key: string): string | undefined => {
		const value = input[key];
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	};

	switch (toolName) {
		case "bash":
		case "powershell": {
			const command = text("command");
			return command ? summarize(command) : "Running a command";
		}
		case "read": {
			const path = text("path");
			return path ? `Reading ${shortPath(path)}` : "Reading";
		}
		case "edit": {
			const path = text("path");
			return path ? `Editing ${shortPath(path)}` : "Editing";
		}
		case "write": {
			const path = text("path");
			return path ? `Writing ${shortPath(path)}` : "Writing";
		}
		case "grep": {
			const pattern = text("pattern");
			return pattern ? `Searching for ${pattern}` : "Searching";
		}
		case "find": {
			const pattern = text("pattern");
			return pattern ? `Finding ${pattern}` : "Finding files";
		}
		case "ls": {
			const path = text("path");
			return path ? `Listing ${shortPath(path)}` : "Listing the directory";
		}
		case "codemode":
			return "Running a script";
		case "subagent":
			return "Waiting on a subagent";
	}

	// Custom tools: the first argument that names what it works on is the best clue.
	const query = text("query") ?? text("pattern");
	if (query) return `Searching for ${query}`;
	const url = text("url");
	if (url) return `Fetching ${host(url)}`;
	const path = text("path");
	if (path) return `Working on ${shortPath(path)}`;
	return `Running ${toolName}`;
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
