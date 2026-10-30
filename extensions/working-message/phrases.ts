/**
 * What a tool call is, in words.
 *
 * Every phrase is a gerund and an object — "Reading a/b.ts", "Searching for foo",
 * "Copying a.ts to tmp" — so the line reads the same whether the work came from a tool or
 * from the shell. Four tables do the work: a tool names its own verb, a shell program maps
 * to one, a program that takes a subcommand (git, npm) maps again, and a program with a
 * destination gets both ends. Anything the tables do not know is echoed as the command or
 * path it was given, because a literal answer beats a wrong guess.
 */

interface Program {
	/** The gerund that opens the phrase. */
	verb: string;
	/** What the first argument is, when naming it reads better than the verb alone. */
	arg?: "file" | "raw" | "host" | "script";
	/** Said when there is no argument to name, so no phrase ever ends on a preposition. */
	alone?: string;
}

/** Shell programs, by the verb that describes them. */
const PROGRAMS: Record<string, Program> = {
	awk: { verb: "Processing text" },
	brew: { verb: "Installing" },
	bun: { verb: "Running", arg: "script", alone: "Running a script" },
	cargo: { verb: "Building" },
	cat: { verb: "Reading", arg: "file", alone: "Reading" },
	cd: { verb: "Changing directory" },
	clang: { verb: "Compiling" },
	cp: { verb: "Copying files" },
	curl: { verb: "Fetching", arg: "host", alone: "Fetching" },
	deno: { verb: "Running", arg: "script", alone: "Running a script" },
	docker: { verb: "Running docker" },
	echo: { verb: "Printing" },
	export: { verb: "Setting up" },
	find: { verb: "Finding", alone: "Finding files" },
	for: { verb: "Looping" },
	gcc: { verb: "Compiling" },
	gh: { verb: "Talking to GitHub" },
	git: { verb: "Running git" },
	go: { verb: "Building" },
	grep: { verb: "Searching for", arg: "raw", alone: "Searching" },
	head: { verb: "Reading", arg: "file", alone: "Reading" },
	jest: { verb: "Running tests" },
	jq: { verb: "Reshaping JSON" },
	linear: { verb: "Talking to Linear" },
	ln: { verb: "Linking files" },
	ls: { verb: "Listing", arg: "file", alone: "Listing the directory" },
	make: { verb: "Building" },
	"mcp-cli": { verb: "Talking to MCP" },
	mkdir: { verb: "Creating", arg: "file", alone: "Creating a directory" },
	mv: { verb: "Moving files" },
	node: { verb: "Running", arg: "script", alone: "Running a script" },
	npm: { verb: "Running npm" },
	pi: { verb: "Spawning pi" },
	pip: { verb: "Installing" },
	pip3: { verb: "Installing" },
	printf: { verb: "Printing" },
	pwd: { verb: "Checking the directory" },
	python: { verb: "Running", arg: "script", alone: "Running a script" },
	python3: { verb: "Running", arg: "script", alone: "Running a script" },
	pytest: { verb: "Running tests" },
	rg: { verb: "Searching for", arg: "raw", alone: "Searching" },
	rm: { verb: "Removing", arg: "file", alone: "Removing files" },
	rsync: { verb: "Syncing files" },
	rustc: { verb: "Compiling" },
	scp: { verb: "Copying files" },
	sed: { verb: "Reading", arg: "file", alone: "Reading" },
	set: { verb: "Setting up" },
	shopt: { verb: "Setting up" },
	ssh: { verb: "Connecting to", arg: "host", alone: "Connecting" },
	tail: { verb: "Reading", arg: "file", alone: "Reading" },
	tmux: { verb: "Driving tmux" },
	tree: { verb: "Listing", arg: "file", alone: "Listing the directory" },
	tsc: { verb: "Typechecking" },
	until: { verb: "Looping" },
	vitest: { verb: "Running tests" },
	wc: { verb: "Counting", arg: "file", alone: "Counting" },
	wget: { verb: "Fetching", arg: "host", alone: "Fetching" },
	which: { verb: "Searching for", arg: "raw", alone: "Searching" },
	while: { verb: "Looping" },
	yarn: { verb: "Running yarn" },
};

/** Programs whose subcommand says more than their name. */
const SUBCOMMANDS: Record<string, Record<string, string>> = {
	bun: { install: "Installing", run: "Running a script", test: "Running tests" },
	cargo: { build: "Building", run: "Running a script", test: "Running tests" },
	gh: { api: "Talking to GitHub", issue: "Talking to GitHub", pr: "Talking to GitHub", run: "Talking to GitHub" },
	git: {
		add: "Staging",
		blame: "Reading the blame",
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
		status: "Reading the status",
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

/** File tools, by the verb that describes them and the argument that names the work. */
const TOOLS: Record<string, Program & { subject: string }> = {
	edit: { verb: "Editing", subject: "path", arg: "file", alone: "Editing" },
	find: { verb: "Finding", subject: "pattern", arg: "raw", alone: "Finding files" },
	grep: { verb: "Searching for", subject: "pattern", arg: "raw", alone: "Searching" },
	ls: { verb: "Listing", subject: "path", arg: "file", alone: "Listing the directory" },
	read: { verb: "Reading", subject: "path", arg: "file", alone: "Reading" },
	write: { verb: "Writing", subject: "path", arg: "file", alone: "Writing" },
};

/** Other tools with a verb of their own. */
const TOOL_VERBS: Record<string, Program> = {
	codemode: { verb: "Running a script" },
	fetch_content: { verb: "Fetching", arg: "host", alone: "Fetching" },
	copy_path: { verb: "Copying", arg: "file", alone: "Copying a file" },
	fzf_select: { verb: "Picking a file" },
	get_search_content: { verb: "Reading the search results" },
	mkdir_path: { verb: "Creating", arg: "file", alone: "Creating a directory" },
	move_path: { verb: "Moving", arg: "file", alone: "Moving a file" },
	process: { verb: "Running a process", arg: "raw" },
	remove_directory: { verb: "Removing", arg: "file", alone: "Removing a directory" },
	remove_file: { verb: "Removing", arg: "file", alone: "Removing a file" },
	request_secret: { verb: "Asking for a secret", arg: "raw" },
	web_fetch: { verb: "Fetching", arg: "host", alone: "Fetching" },
	web_search: { verb: "Searching the web for", arg: "raw", alone: "Searching the web" },
	web_enable: { verb: "Enabling web access" },
};

/** Anything that names a credential is reduced to its program, never echoed. */
const SECRET = /token|secret|password|bearer|api[-_]?key/i;

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

/** The last two segments: enough to know the file, short enough to fit. */
function shortPath(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || path;
}

/** The host of a URL, or the word itself when it is not one. */
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

/** A subject as the line shows it: a file, a host, a script name, or a bare word. */
function shown(subject: string, arg: NonNullable<Program["arg"]>): string {
	const bare = stripQuotes(subject);
	if (arg === "file") return shortPath(bare);
	if (arg === "host") return host(bare);
	if (arg === "script") return baseName(bare);
	return bare;
}

/** A verb with whatever names the work, or the phrase that stands without one. */
function phrase(entry: Program, subject: string | undefined): string {
	if (!subject) return entry.alone ?? entry.verb;
	if (!entry.arg) return entry.verb;
	return `${entry.verb} ${shown(subject, entry.arg)}`;
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
		return first && first !== "." ? `Finding in ${shortPath(first)}` : "Finding files";
	}

	const known = PROGRAMS[program];
	return known ? phrase(known, first) : undefined;
}

/** A shell command as a phrase, from its program and subcommand. */
export function summarize(command: string): string {
	// `VAR=value` and the setup lines say nothing about the work itself.
	const work = workLine(command);
	const stripped = (work?.text ?? "").replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").trim();
	if (!stripped) return "Running a command";
	// Nothing but an assignment is left: the script sets something up and says no more.
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(stripped)) return "Setting up";
	const [head = "", ...rest] = stripped.split(/\s+/);
	const program = head.split(/[\\/]/).pop() ?? head;
	const sub = positional(program, rest);

	// `cat > file <<'EOF'` writes the file it names; it is not reading anything. Discarding
	// the output in /dev/null leaves the reading as the work.
	if (WRITERS.has(program)) {
		const written = work?.rest.match(/>>?\s*(\S+)/)?.[1]?.replace(/[;&|]+$/, "");
		if (written && stripQuotes(written) !== "/dev/null") {
			return `Writing ${shortPath(stripQuotes(written))}`;
		}
	}

	// `node -e "…"` names no file; the code itself is not worth showing.
	if (
		(program === "node" || program === "python" || program === "python3" || program === "deno") &&
		rest.some((token) => token === "-e" || token === "-c" || token === "--eval")
	) {
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

/** What the tool is doing, from its name and the arguments it was given. */
export function describe(toolName: string, args: unknown): string {
	const input = (args ?? {}) as Record<string, unknown>;
	const text = (key: string): string | undefined => {
		const value = input[key];
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	};

	if (toolName === "bash" || toolName === "powershell") {
		const command = text("command");
		return command ? summarize(command) : "Running a command";
	}

	const tool = TOOLS[toolName];
	if (tool) return phrase(tool, text(tool.subject));

	// Every other tool names its verb in the table; what it works on comes from whichever
	// argument says it, so a copy still shows both ends.
	const entry = TOOL_VERBS[toolName];
	if (entry) {
		const from = text("from") ?? text("source") ?? text("src");
		const to = text("to") ?? text("destination") ?? text("dest") ?? text("target");
		if (from && to) return `${entry.verb} ${shortPath(from)} to ${shortPath(to)}`;
		const subject = text("query") ?? text("url") ?? text("path") ?? text("file") ?? text("name");
		return phrase(entry, subject);
	}

	// A tool the tables have never seen: the first argument that names what it works on is
	// the best clue, and the tool's own name is the last resort.
	const searched = text("query") ?? text("pattern");
	if (searched) return `Searching for ${stripQuotes(searched)}`;
	const url = text("url");
	if (url) return `Fetching ${host(url)}`;
	const path = text("path");
	if (path) return `Working on ${shortPath(path)}`;
	return `Running ${toolName}`;
}
