import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;

type GitStats = { additions: number; deletions: number } | null;

function shellGreen(text: string): string {
	return `\x1b[32m${text}\x1b[39m`;
}

function shellRed(text: string): string {
	return `\x1b[31m${text}\x1b[39m`;
}

function countTextLines(buffer: Buffer): number {
	if (buffer.length === 0 || buffer.includes(0)) return 0;

	let lines = 0;
	for (const byte of buffer) {
		if (byte === 10) lines++;
	}
	return buffer.at(-1) === 10 ? lines : lines + 1;
}

async function countUntrackedAdditions(cwd: string): Promise<number> {
	const { stdout } = await execFileAsync("git", ["-C", cwd, "ls-files", "--others", "--exclude-standard", "-z"], {
		timeout: 5000,
		maxBuffer: 1024 * 1024,
		encoding: "buffer",
	});

	let additions = 0;
	for (const file of stdout.toString("utf8").split("\0")) {
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

async function getGitBranch(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, "branch", "--show-current"], {
			timeout: 5000,
			maxBuffer: 64 * 1024,
		});
		const branch = stdout.trim();
		if (branch) return branch;

		const detached = await execFileAsync("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
			timeout: 5000,
			maxBuffer: 64 * 1024,
		});
		return detached.stdout.trim() || null;
	} catch {
		return null;
	}
}

async function getGitStats(cwd: string): Promise<GitStats> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, "diff", "--numstat", "HEAD", "--"], {
			timeout: 5000,
			maxBuffer: 1024 * 1024,
		});
		let additions = 0;
		let deletions = 0;

		for (const line of stdout.trim().split("\n")) {
			if (!line) continue;
			const [added, deleted] = line.split("\t");
			if (added !== "-") additions += Number(added) || 0;
			if (deleted !== "-") deletions += Number(deleted) || 0;
		}

		additions += await countUntrackedAdditions(cwd);

		return { additions, deletions };
	} catch {
		return null;
	}
}

function gitStatsText(stats: GitStats): string {
	if (!stats || (stats.additions === 0 && stats.deletions === 0)) return "";
	return ` ${shellGreen(`+${stats.additions}`)} ${shellRed(`-${stats.deletions}`)}`;
}

async function gitStatusText(cwd: string): Promise<string | undefined> {
	const branch = await getGitBranch(cwd);
	if (!branch) return undefined;
	return `${shellGreen(`(${branch})`)}${gitStatsText(await getGitStats(cwd))}`;
}

export default function (pi: ExtensionAPI) {
	let refresh: (() => void) | undefined;
	let lastStatus: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const update = async () => {
			const status = await gitStatusText(ctx.cwd);
			if (status === lastStatus) return;
			lastStatus = status;
			ctx.ui.setStatus("git", status);
		};
		refresh = () => void update();
		refresh();
	});

	pi.on("message_end", async () => refresh?.());
	pi.on("turn_end", async () => refresh?.());

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("git", undefined);
		refresh = undefined;
		lastStatus = undefined;
	});
}
