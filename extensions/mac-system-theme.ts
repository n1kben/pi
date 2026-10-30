/**
 * Syncs pi theme with macOS system appearance (dark/light mode).
 *
 * Installed globally for pi from ~/.pi/agent/extensions/mac-system-theme.ts.
 * Override theme names with:
 *   PI_MAC_DARK_THEME=my-dark PI_MAC_LIGHT_THEME=my-light pi
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DARK_THEME = process.env.PI_MAC_DARK_THEME ?? "custom-dark";
const LIGHT_THEME = process.env.PI_MAC_LIGHT_THEME ?? "custom-light";
const POLL_MS = Math.max(250, Number(process.env.PI_MAC_THEME_POLL_MS ?? 1000));
const DARK_MODE_SCRIPT =
	'tell application "System Events" to tell appearance preferences to return dark mode';

async function isDarkMode(pi: ExtensionAPI): Promise<boolean> {
	const { stdout, code } = await pi.exec("osascript", ["-e", DARK_MODE_SCRIPT]);
	return code === 0 && stdout.trim() === "true";
}

export default function (pi: ExtensionAPI) {
	let intervalId: ReturnType<typeof setInterval> | null = null;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		// macOS-only: on other platforms leave the configured theme untouched.
		if (process.platform !== "darwin") return;

		let currentTheme: string | undefined;
		const syncTheme = async () => {
			const theme = (await isDarkMode(pi)) ? DARK_THEME : LIGHT_THEME;
			if (theme === currentTheme) return;
			currentTheme = theme;
			ctx.ui.setTheme(theme);
		};

		await syncTheme();
		intervalId = setInterval(syncTheme, POLL_MS);
	});

	pi.on("session_shutdown", () => {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
	});
}
