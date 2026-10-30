import { copyToClipboard, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("copy-session-id", {
		description: "Copy Pi session id to clipboard",
		handler: async (_args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId() || "ephemeral";
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
