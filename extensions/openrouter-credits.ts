/**
 * OpenRouter wallet balance.
 *
 * Shows the remaining balance from https://openrouter.ai/api/v1/credits in the
 * footer (right side, next to the model) and refreshes it as you spend:
 *
 *   - footer:   "$9.81" (green-ish muted, warning when low, error when nearly empty)
 *   - /credits: wallet detail (purchased, used, remaining) + usage today/week/month
 *
 * The API key is read from OPENROUTER_API_KEY or ~/.pi/agent/auth.json, so the
 * indicator only appears when an OpenRouter key is configured.
 *
 * Tunables (env):
 *   PI_OPENROUTER_CREDITS_MODE   left | spent | both   (default: left)
 *   PI_OPENROUTER_CREDITS_POLL_MS refresh interval      (default: 120000)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "openrouter-credits";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CACHE_FILE = join(AGENT_DIR, "openrouter-credits.json");
const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const KEY_URL = "https://openrouter.ai/api/v1/key";
const POLL_MS = Math.max(30_000, Number(process.env.PI_OPENROUTER_CREDITS_POLL_MS ?? 120_000));
/** Don't hit the API more often than this, even on turn_end. */
const MIN_FETCH_INTERVAL_MS = 30_000;

type Mode = "left" | "spent" | "both";

const MODE: Mode = (() => {
	const raw = process.env.PI_OPENROUTER_CREDITS_MODE?.trim().toLowerCase();
	return raw === "spent" || raw === "both" ? raw : "left";
})();

interface Credits {
	totalCredits: number;
	totalUsage: number;
	remaining: number;
	fetchedAt: number;
}

interface KeyUsage {
	usageDaily?: number;
	usageWeekly?: number;
	usageMonthly?: number;
	limitRemaining?: number | null;
}

let credits: Credits | undefined;
let inflight: Promise<void> | undefined;
let lastFetchAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function apiKey(): string | undefined {
	const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
	if (fromEnv) return fromEnv;

	try {
		const auth = JSON.parse(readFileSync(join(AGENT_DIR, "auth.json"), "utf8")) as Record<string, unknown>;
		const entry = auth.openrouter;
		if (typeof entry === "string") return entry;
		if (entry && typeof entry === "object") {
			const value = (entry as Record<string, unknown>).access ?? (entry as Record<string, unknown>).key;
			// `!command` keys are resolved by pi itself; don't try to run them here.
			if (typeof value === "string" && value && !value.startsWith("!")) return value;
		}
	} catch {
		// No key file / unreadable: indicator stays hidden.
	}
	return undefined;
}

function loadCache(): Credits | undefined {
	try {
		const raw = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Partial<Credits>;
		if (typeof raw.remaining === "number" && typeof raw.totalUsage === "number") {
			return {
				totalCredits: Number(raw.totalCredits ?? raw.remaining + raw.totalUsage),
				totalUsage: raw.totalUsage,
				remaining: raw.remaining,
				fetchedAt: Number(raw.fetchedAt ?? 0),
			};
		}
	} catch {
		// No cache yet.
	}
	return undefined;
}

function saveCache(value: Credits): void {
	try {
		writeFileSync(CACHE_FILE, JSON.stringify(value));
	} catch {
		// Caching is best-effort.
	}
}

function formatAmount(value: number): string {
	const sign = value < 0 ? "-" : "";
	const abs = Math.abs(value);
	if (abs >= 1000) return `${sign}$${Math.round(abs / 100) / 10}k`;
	if (abs >= 100) return `${sign}$${abs.toFixed(0)}`;
	return `${sign}$${abs.toFixed(2)}`;
}

function statusText(value: Credits): string {
	if (MODE === "spent") return `-${formatAmount(value.totalUsage)}`;
	if (MODE === "both") return `${formatAmount(value.remaining)}/${formatAmount(value.totalUsage)}`;
	return formatAmount(value.remaining);
}

async function requestJson(url: string, key: string): Promise<Record<string, unknown> | undefined> {
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return undefined;
		return (await res.json()) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function publish(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, credits ? statusText(credits) : undefined);
}

async function refresh(ctx: ExtensionContext, force = false): Promise<void> {
	const key = apiKey();
	if (!key) {
		credits = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	if (inflight) return inflight;
	if (!force && Date.now() - lastFetchAt < MIN_FETCH_INTERVAL_MS) return;

	inflight = (async () => {
		const body = await requestJson(CREDITS_URL, key);
		lastFetchAt = Date.now();
		const data = body?.data as Record<string, unknown> | undefined;
		if (!data || typeof data.total_credits !== "number") return;

		const totalCredits = data.total_credits;
		const totalUsage = typeof data.total_usage === "number" ? data.total_usage : 0;
		credits = {
			totalCredits,
			totalUsage,
			remaining: totalCredits - totalUsage,
			fetchedAt: Date.now(),
		};
		saveCache(credits);
		publish(ctx);
	})()
		.catch(() => {
			// Never break the session over a balance lookup.
		})
		.finally(() => {
			inflight = undefined;
		});

	return inflight;
}

async function fetchKeyUsage(): Promise<KeyUsage | undefined> {
	const key = apiKey();
	if (!key) return undefined;
	const body = await requestJson(KEY_URL, key);
	const data = body?.data as Record<string, unknown> | undefined;
	if (!data) return undefined;
	return {
		usageDaily: typeof data.usage_daily === "number" ? data.usage_daily : undefined,
		usageWeekly: typeof data.usage_weekly === "number" ? data.usage_weekly : undefined,
		usageMonthly: typeof data.usage_monthly === "number" ? data.usage_monthly : undefined,
		limitRemaining: typeof data.limit_remaining === "number" ? data.limit_remaining : null,
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!apiKey()) return;
		// Show the last known balance immediately, then refresh in the background.
		credits ??= loadCache();
		publish(ctx);
		void refresh(ctx, true);

		if (timer) clearInterval(timer);
		timer = setInterval(() => void refresh(ctx, true), POLL_MS);
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	});

	// Costs land on turn_end: refresh (throttled) so the balance follows spending.
	pi.on("turn_end", async (_event, ctx) => void refresh(ctx));

	pi.registerCommand("credits", {
		description: "Show your OpenRouter wallet balance and usage",
		handler: async (_args, ctx) => {
			if (!apiKey()) {
				ctx.ui.notify("No OpenRouter key found (OPENROUTER_API_KEY or auth.json)", "warning");
				return;
			}
			await refresh(ctx, true);
			if (!credits) {
				ctx.ui.notify("Could not read OpenRouter credits", "error");
				return;
			}
			const usage = await fetchKeyUsage();
			const lines = [
				`remaining   ${formatAmount(credits.remaining)}`,
				`purchased   ${formatAmount(credits.totalCredits)}`,
				`used        ${formatAmount(credits.totalUsage)}`,
			];
			if (usage?.limitRemaining != null) lines.push(`key limit   ${formatAmount(usage.limitRemaining)} left`);
			if (usage?.usageDaily !== undefined) lines.push(`today       ${formatAmount(usage.usageDaily)}`);
			if (usage?.usageWeekly !== undefined) lines.push(`this week   ${formatAmount(usage.usageWeekly)}`);
			if (usage?.usageMonthly !== undefined) lines.push(`this month  ${formatAmount(usage.usageMonthly)}`);
			const age = credits.fetchedAt ? Math.round((Date.now() - credits.fetchedAt) / 1000) : null;
			if (age !== null) lines.push(`updated     ${age}s ago`);
			ctx.ui.notify(`OpenRouter wallet\n${lines.join("\n")}`, "info");
		},
	});
}
