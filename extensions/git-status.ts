import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { promises as fs } from "node:fs";
import { join } from "node:path";

type GitStats = { additions: number; deletions: number } | null;
type Exec = ExtensionAPI["exec"];

const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;

function shellGreen(text: string): string {
	return `\x1b[32m${text}\x1b[39m`;
}

function shellRed(text: string): string {
	return `\x1b[31m${text}\x1b[39m`;
}

/** Trimmed stdout of a git command, or undefined when it fails (e.g. not a repo). */
async function git(exec: Exec, cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout, code } = await exec("git", args, { cwd, timeout: 5000 });
		return code === 0 ? stdout : undefined;
	} catch {
		// Session ended mid-refresh (exec rejects once its ctx is stale) or git is unavailable.
		return undefined;
	}
}

function countTextLines(buffer: Buffer): number {
	if (buffer.length === 0 || buffer.includes(0)) return 0;

	let lines = 0;
	for (const byte of buffer) {
		if (byte === 10) lines++;
	}
	return buffer.at(-1) === 10 ? lines : lines + 1;
}

async function countUntrackedAdditions(exec: Exec, cwd: string): Promise<number> {
	const listed = await git(exec, cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (listed === undefined) return 0;

	let additions = 0;
	for (const file of listed.split("\0")) {
		if (!file) continue;

		try {
			const path = join(cwd, file);
			const stat = await fs.stat(path);
			if (!stat.isFile() || stat.size > MAX_UNTRACKED_FILE_BYTES) continue;
			additions += countTextLines(await fs.readFile(path));
		} catch {
			// Ignore files that disappeared or cannot be read while stats are refreshing.
		}
	}

	return additions;
}

async function getGitStats(exec: Exec, cwd: string): Promise<GitStats> {
	const numstat = await git(exec, cwd, ["diff", "--numstat", "HEAD", "--"]);
	if (numstat === undefined) return null;

	let additions = 0;
	let deletions = 0;

	for (const line of numstat.trim().split("\n")) {
		if (!line) continue;
		const [added, deleted] = line.split("\t");
		if (added !== "-") additions += Number(added) || 0;
		if (deleted !== "-") deletions += Number(deleted) || 0;
	}

	additions += await countUntrackedAdditions(exec, cwd);

	return { additions, deletions };
}

function gitStatsText(stats: GitStats): string {
	if (!stats || (stats.additions === 0 && stats.deletions === 0)) return "";
	return ` ${shellGreen(`+${stats.additions}`)} ${shellRed(`-${stats.deletions}`)}`;
}

/**
 * Only the line counts: the branch is pi's footer data, which watches HEAD and
 * handles worktrees and detached HEAD without a subprocess of ours.
 */
async function gitStatusText(exec: Exec, cwd: string): Promise<string | undefined> {
	const stats = await getGitStats(exec, cwd);
	return stats ? gitStatsText(stats) || undefined : undefined;
}

export default function (pi: ExtensionAPI) {
	const exec: Exec = (command, args, options) => pi.exec(command, args, options);
	let refresh: (() => void) | undefined;
	let lastStatus: string | undefined;
	let closed = true;

	pi.on("session_start", async (_event, ctx) => {
		closed = false;
		const update = async () => {
			const status = await gitStatusText(exec, ctx.cwd);
			if (closed || status === lastStatus) return;
			lastStatus = status;
			ctx.ui.setStatus("git", status);
		};
		refresh = () => void update().catch(() => {});
		refresh();
	});

	pi.on("message_end", async () => refresh?.());
	pi.on("turn_end", async () => refresh?.());

	pi.on("session_shutdown", async (_event, ctx) => {
		closed = true;
		if (ctx.hasUI) ctx.ui.setStatus("git", undefined);
		refresh = undefined;
		lastStatus = undefined;
	});
}
