/**
 * Syncs pi theme with macOS system appearance (dark/light mode).
 *
 * Installed globally for pi from ~/.pi/agent/extensions/mac-system-theme.ts.
 * Override theme names with:
 *   PI_MAC_DARK_THEME=my-dark PI_MAC_LIGHT_THEME=my-light pi
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execAsync = promisify(exec);
const DARK_THEME = process.env.PI_MAC_DARK_THEME ?? "custom-dark";
const LIGHT_THEME = process.env.PI_MAC_LIGHT_THEME ?? "custom-light";
const POLL_MS = Math.max(250, Number(process.env.PI_MAC_THEME_POLL_MS ?? 1000));

async function isDarkMode(): Promise<boolean> {
	try {
		const { stdout } = await execAsync(
			"osascript -e 'tell application \"System Events\" to tell appearance preferences to return dark mode'",
		);
		return stdout.trim() === "true";
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	let intervalId: ReturnType<typeof setInterval> | null = null;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		// macOS-only: on other platforms leave the configured theme untouched.
		if (process.platform !== "darwin") return;

		let currentTheme = (await isDarkMode()) ? DARK_THEME : LIGHT_THEME;
		ctx.ui.setTheme(currentTheme);

		intervalId = setInterval(async () => {
			const newTheme = (await isDarkMode()) ? DARK_THEME : LIGHT_THEME;
			if (newTheme !== currentTheme) {
				currentTheme = newTheme;
				ctx.ui.setTheme(currentTheme);
			}
		}, POLL_MS);
	});

	pi.on("session_shutdown", () => {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
	});
}
