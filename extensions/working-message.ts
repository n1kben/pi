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

/** Programs whose job reads better than their name; `arg` says what to name after it. */
const PROGRAMS: Record<string, { verb: string; arg?: "file" | "raw" | "host" | "script" }> = {
	awk: { verb: "Milling text" },
	brew: { verb: "Installing" },
	bun: { verb: "Running", arg: "script" },
	cargo: { verb: "Building" },
	cat: { verb: "Reading", arg: "file" },
	cd: { verb: "Changing directory" },
	clang: { verb: "Compiling" },
	cp: { verb: "Copying files" },
	curl: { verb: "Fetching", arg: "host" },
	deno: { verb: "Running", arg: "script" },
	docker: { verb: "Running docker" },
	echo: { verb: "Printing" },
	export: { verb: "Setting up" },
	find: { verb: "Finding" },
	for: { verb: "Looping" },
	gcc: { verb: "Compiling" },
	gh: { verb: "Talking to GitHub" },
	git: { verb: "Running git" },
	go: { verb: "Building" },
	grep: { verb: "Searching for", arg: "raw" },
	head: { verb: "Reading", arg: "file" },
	jest: { verb: "Running tests" },
	jq: { verb: "Reshaping json" },
	linear: { verb: "Talking to Linear" },
	ln: { verb: "Linking files" },
	ls: { verb: "Listing", arg: "file" },
	make: { verb: "Building" },
	"mcp-cli": { verb: "Talking to MCP" },
	mkdir: { verb: "Creating", arg: "file" },
	mv: { verb: "Moving files" },
	node: { verb: "Running", arg: "script" },
	npm: { verb: "Running npm" },
	pi: { verb: "Spawning pi" },
	pip: { verb: "Installing" },
	pip3: { verb: "Installing" },
	printf: { verb: "Printing" },
	pwd: { verb: "Looking around" },
	python: { verb: "Running", arg: "script" },
	python3: { verb: "Running", arg: "script" },
	pytest: { verb: "Running tests" },
	rg: { verb: "Searching for", arg: "raw" },
	rm: { verb: "Removing", arg: "file" },
	rsync: { verb: "Syncing files" },
	rustc: { verb: "Compiling" },
	scp: { verb: "Copying files" },
	sed: { verb: "Reading", arg: "file" },
	set: { verb: "Setting up" },
	shopt: { verb: "Setting up" },
	ssh: { verb: "Connecting to", arg: "host" },
	tail: { verb: "Reading", arg: "file" },
	tmux: { verb: "Driving tmux" },
	tree: { verb: "Listing", arg: "file" },
	tsc: { verb: "Typechecking" },
	until: { verb: "Looping" },
	vitest: { verb: "Running tests" },
	wc: { verb: "Counting", arg: "file" },
	wget: { verb: "Fetching", arg: "host" },
	which: { verb: "Looking for", arg: "raw" },
	while: { verb: "Looping" },
	yarn: { verb: "Running yarn" },
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
	const parts = path.split(/[\\/]/).filter(Boolean);
	const last = parts.pop() ?? path;
	// A path ending in a dot names the directory before it, not the dot.
	return last === "." || last === ".." ? (parts.pop() ?? last) : last;
}

/** The directory a path sits in, as the line can afford to show it. */
function parentPath(path: string): string {
	const parts = path.split(/[\\/]/).filter((part) => part && part !== "." && part !== "..");
	return parts.slice(0, -1).slice(-2).join("/");
}

/** A quote pair around a shell word, kept out of the line. */
function stripQuotes(text: string): string {
	return text.replace(/^['"]|['"]$/g, "");
}

interface Segment {
	/** The command itself, cut where the separator ends it. */
	text: string;
	/** The line from this command on, which is where a redirect names its file. */
	rest: string;
}

/** The pieces of one line, split where one command ends and the next begins. */
function segments(line: string): Segment[] {
	const parts: Segment[] = [];
	let quote = "";
	let start = 0;
	const push = (end: number) => parts.push({ text: line.slice(start, end), rest: line.slice(start) });
	for (let i = 0; i < line.length; i++) {
		const char = line[i]!;
		if (quote) {
			if (char === "\\") i++;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (";|&<>".includes(char)) {
			push(i);
			start = i + 1;
		}
	}
	push(line.length);
	return parts;
}

/** Lines that set the shell up or only name a variable, leaving nothing to report. */
const SETUP =
	/^(set|export|shopt|umask|unset)\b|^(echo|printf)\b|^[A-Za-z_][A-Za-z0-9_]*=(\S*|"[^"]*"|'[^']*')\s*$/;

/** Programs that write whatever a redirect points at. */
const WRITERS = new Set(["cat", "echo", "printf", "tee"]);

/**
 * Flags whose next word is a value, so it is not the thing being worked on. They differ
 * per program: `-n` is a line count to `head` and a line number to `rg`.
 */
const VALUED: Record<string, Set<string>> = {
	curl: new Set(["-d", "-H", "-o", "-u", "-X", "--output"]),
	deno: new Set(["-e", "--eval"]),
	git: new Set(["-C", "-c"]),
	grep: new Set(["-e", "--regexp"]),
	head: new Set(["-c", "-n"]),
	node: new Set(["-e", "--eval"]),
	python: new Set(["-c", "-m"]),
	python3: new Set(["-c", "-m"]),
	rg: new Set(["-e", "--regexp", "-g"]),
	scp: new Set(["-i", "-o", "-P"]),
	ssh: new Set(["-F", "-i", "-l", "-o", "-p"]),
	tail: new Set(["-c", "-n"]),
};

/**
 * The first command in a script that says what the work is. Setup and navigation do not:
 * a script opening with `set -e`, `export`, or `cd` would otherwise be reported as if that
 * were the work. If it is all setup, the first of those is the best answer left.
 */
function workLine(command: string): Segment | undefined {
	let skipped: Segment | undefined;
	for (const raw of command.split("\n")) {
		for (const part of segments(raw)) {
			const line = part.text.trim();
			if (!line || line.startsWith("#")) continue;
			if (SETUP.test(line) || /^cd\b/.test(line)) {
				skipped ??= { text: line, rest: part.rest };
				continue;
			}
			return { text: line, rest: part.rest };
		}
	}
	return skipped;
}

/** "Copying a.ts to tmp": the two paths, not just the fact that files moved. */
function transfer(verb: string, args: readonly string[]): string | undefined {
	const paths = args.filter((token) => !token.startsWith("-"));
	if (paths.length < 2) return undefined;
	// The source is a file name, the destination a place: two segments say which tmp.
	const last = paths[paths.length - 1]!;
	const destination = last === "." ? "here" : shortPath(last);
	const sources = paths.slice(0, -1);
	if (sources.length > 1) return `${verb} ${sources.length} files to ${destination}`;
	const source = baseName(sources[0]!);
	if (source !== baseName(destination)) return `${verb} ${source} to ${destination}`;
	// The same name on both ends (a log pulled down, a config copied home) cannot show
	// direction by name, so the directory it lands in does.
	const parent = last === "." ? "" : parentPath(last);
	return parent ? `${verb} ${source} to ${parent}` : `${verb} ${source}`;
}

/** What the program and its arguments say, for the programs the table knows. */
function programPhrase(program: string, args: readonly string[]): string | undefined {
	const first = positional(program, args);

	if (program === "sed") {
		// `sed -n` prints and `sed -i` rewrites: the flag is the whole difference. The file
		// is the last word, because the script before it is not a file name.
		const editing = args.some((token) => /^-[a-zA-Z]*i/.test(token));
		const file = args.filter((token) => !token.startsWith("-") && stripQuotes(token)).pop();
		if (!file) return editing ? "Editing in place" : "Reading";
		return `${editing ? "Editing" : "Reading"} ${shortPath(file)}`;
	}

	if (program === "find") {
		const flag = args.findIndex((token) => token === "-name" || token === "-iname");
		const pattern = flag === -1 ? undefined : args[flag + 1];
		if (pattern) return `Finding ${stripQuotes(pattern)}`;
		return first && first !== "." ? `Finding in ${shortPath(first)}` : "Finding";
	}

	const known = PROGRAMS[program];
	if (!known) return undefined;
	if (!first) return known.arg === "script" ? "Running a script" : known.verb;
	if (!known.arg) return known.verb;
	const subject =
		known.arg === "file"
			? shortPath(first)
			: known.arg === "host"
				? host(first)
				: known.arg === "script"
					? baseName(stripQuotes(first))
					: stripQuotes(first);
	return `${known.verb} ${subject}`;
}

/** The first argument that is a thing, not a flag or a flag's value. */
function positional(program: string, args: readonly string[]): string | undefined {
	const valued = VALUED[program];
	let skipNext = false;
	for (const token of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (token.startsWith("-")) {
			skipNext = valued?.has(token) === true;
			continue;
		}
		return token;
	}
	return undefined;
}

/** A shell command as a phrase, from its program and subcommand. */
function summarize(command: string): string {
	// `VAR=value` and the setup lines say nothing about the work itself.
	const work = workLine(command);
	const stripped = (work?.text ?? "").replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").trim();
	if (!stripped) return "Running a command";
	// Nothing but an assignment is left: the script sets something up and says no more.
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(stripped)) return "Setting up";
	const [head = "", ...rest] = stripped.split(/\s+/);
	const program = head.split(/[\\/]/).pop() ?? head;
	const sub = positional(program, rest);

	// `cat > file <<'EOF'` writes the file it names; it is not reading anything.
	if (WRITERS.has(program)) {
		const written = work?.rest.match(/>>?\s*(\S+)/)?.[1]?.replace(/[;&|]+$/, "");
		if (written) return `Writing ${shortPath(stripQuotes(written))}`;
	}

	// `node -e "…"` names no file; the code itself is not worth showing.
	if ((program === "node" || program === "python" || program === "python3" || program === "deno")
		&& rest.some((token) => token === "-e" || token === "-c" || token === "--eval")) {
		return "Running a snippet";
	}

	// `timeout 60 npm test` is the command it wraps, not a program called timeout.
	if (program === "timeout") {
		const duration = rest.findIndex((token) => /^\d+[smhd]?$/.test(token));
		if (duration !== -1) return summarize(rest.slice(duration + 1).join(" "));
	}

	if (TRANSFER[program]) {
		const moved = transfer(TRANSFER[program]!, rest);
		if (moved) return moved;
	}

	const bySub = sub ? SUBCOMMANDS[program]?.[sub] : undefined;
	if (bySub) return bySub;

	const known = programPhrase(program, rest);
	if (known) return known;
	if (SECRET.test(stripped) || rest.some((token) => token.includes("="))) return `Running ${program}`;
	return sub ? `Running ${program} ${sub}` : `Running ${program}`;
}

/** Tools with a verb of their own, apart from the file tools the switch below knows. */
const TOOL_VERBS: Record<string, string> = {
	codemode: "Running a script",
	copy_path: "Copying",
	fzf_select: "Picking a file",
	get_search_content: "Reading the search results",
	mkdir_path: "Creating",
	move_path: "Moving",
	process: "Running a process",
	remove_directory: "Removing",
	remove_file: "Removing",
	request_secret: "Asking for a secret",
	web_enable: "Enabling web access",
};

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
	}

	// Every other tool names its verb in the table above; what it works on comes from
	// whichever argument says it, so a copy still shows both ends.
	const verb = TOOL_VERBS[toolName];
	if (verb) {
		const from = text("from") ?? text("source") ?? text("src");
		const to = text("to") ?? text("destination") ?? text("dest") ?? text("target");
		if (from && to) return `${verb} ${shortPath(from)} to ${shortPath(to)}`;
		const subject = text("path") ?? text("file") ?? text("name");
		return subject ? `${verb} ${shortPath(subject)}` : verb;
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
