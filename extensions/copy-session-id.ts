import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";

function getSessionId(ctx: ExtensionContext): string {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return "ephemeral";

	const sessionName = basename(sessionFile, ".jsonl");
	const id = sessionName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0];
	return id ?? sessionName;
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
