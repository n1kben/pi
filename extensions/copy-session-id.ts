import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function getSessionId(ctx: ExtensionContext): string {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return "ephemeral";

	const sessionName = basename(sessionFile, ".jsonl");
	const id = sessionName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0];
	return id ?? sessionName;
}

async function copyToClipboard(text: string): Promise<void> {
	if (process.platform === "darwin") {
		await execFileAsync("pbcopy", { input: text });
		return;
	}

	if (process.platform === "win32") {
		await execFileAsync("clip", { input: text });
		return;
	}

	if (process.env.TERMUX_VERSION) {
		await execFileAsync("termux-clipboard-set", { input: text });
		return;
	}

	if (process.env.WAYLAND_DISPLAY) {
		await execFileAsync("wl-copy", { input: text });
		return;
	}

	await execFileAsync("xclip", ["-selection", "clipboard"], { input: text });
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("copy-session-id", {
		description: "Copy Pi session id to clipboard",
		handler: async (_args, ctx) => {
			const sessionId = getSessionId(ctx);
			try {
				await copyToClipboard(sessionId);
				ctx.ui.notify(`Copied session id: ${sessionId}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to copy session id: ${message}`, "error");
			}
		},
	});
}
