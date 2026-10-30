/**
 * OpenRouter provider: wallet balance and upstream provider.
 *
 * OpenRouter is the default provider here, and both facts are about the same
 * thing — what is serving you and what it costs. The footer gets both:
 *
 *   - upstream: "parasail" as the model's prefix (the router's choice per
 *               request; the catalog model ID and price don't tell you)
 *   - balance:  remaining wallet after the model, colored by how low it is
 *
 * The balance only shows while an OpenRouter model is selected: it is money
 * for OpenRouter requests, so it is noise on any other provider. It is shown
 * from the cached value immediately and refreshed as you spend.
 *
 * Commands:
 *   /credits   wallet detail (purchased, used, remaining) + usage today/week/month
 *
 * The API key is the one pi resolves for the OpenRouter provider (environment,
 * auth.json including `!command` keys, OAuth, models.json), so the balance only
 * appears when an OpenRouter key is configured.
 *
 * Tunables (env):
 *   PI_OPENROUTER_CREDITS_MODE   left | spent | both   (default: left)
 *   PI_OPENROUTER_CREDITS_POLL_MS refresh interval      (default: 120000)
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_DIR = getAgentDir();
const PROVIDER = "openrouter";

const CREDITS_STATUS_KEY = "openrouter-credits";
const UPSTREAM_STATUS_KEY = "openrouter-upstream";
const UPSTREAM_STATE_TYPE = "openrouter-upstream";

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

interface Request {
	model: string;
	provider: string;
	/** Grouping key for the stream events that belong to one request. */
	generationId?: string;
}

interface PersistedProvider {
	provider: string;
	model: string;
}

let credits: Credits | undefined;
let inflight: Promise<void> | undefined;
let lastFetchAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** Whether the selected model goes through OpenRouter; gates the balance. */
let active = false;

/** Last request of this session. */
let request: Request | undefined;
/** Last provider seen in this session; survives /reload via the session entry. */
let displayedProvider: string | undefined;
/** Provider already written to the session, to avoid one entry per turn. */
let persistedProvider: string | undefined;

function isOpenRouter(model: { provider?: string } | undefined): boolean {
	return model?.provider === PROVIDER;
}

// ---------------------------------------------------------------------------
// Wallet balance
// ---------------------------------------------------------------------------

/** Exactly the key pi sends to OpenRouter, however it was configured. */
function apiKey(ctx: ExtensionContext): Promise<string | undefined> {
	return ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
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

function publishCredits(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(CREDITS_STATUS_KEY, active && credits ? statusText(credits) : undefined);
}

async function refresh(ctx: ExtensionContext, force = false): Promise<void> {
	const key = await apiKey(ctx);
	if (!key) {
		credits = undefined;
		publishCredits(ctx);
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
		publishCredits(ctx);
	})()
		.catch(() => {
			// Never break the session over a balance lookup.
		})
		.finally(() => {
			inflight = undefined;
		});

	return inflight;
}

async function fetchKeyUsage(ctx: ExtensionContext): Promise<KeyUsage | undefined> {
	const key = await apiKey(ctx);
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

/** Refresh only while OpenRouter is paying for the turn. */
function refreshIfActive(ctx: ExtensionContext, force = false): void {
	if (!active) return;
	void refresh(ctx, force);
}

// ---------------------------------------------------------------------------
// Upstream provider
// ---------------------------------------------------------------------------

/** Latest provider recorded on this session's current branch, if any. */
function persistedState(ctx: ExtensionContext): PersistedProvider | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== UPSTREAM_STATE_TYPE) continue;
		const data = entry.data as Partial<PersistedProvider> | undefined;
		if (data && typeof data.provider === "string") return data as PersistedProvider;
	}
	return undefined;
}

/**
 * Pi clears extension statuses whenever the runtime is reloaded, so the indicator
 * must be re-published on every session_start (which also fires on /reload).
 * In-memory state is gone at that point, so the last provider is restored from
 * this session's own entries — never from the log, which all sessions share.
 */
function syncUpstream(ctx: ExtensionContext, model: ExtensionContext["model"]): void {
	if (!ctx.hasUI) return;
	if (!isOpenRouter(model)) {
		ctx.ui.setStatus(UPSTREAM_STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(UPSTREAM_STATUS_KEY, displayedProvider ?? "–");
}

/** Both footer indicators move together when the model changes. */
function publishAll(ctx: ExtensionContext, model: ExtensionContext["model"]): void {
	syncUpstream(ctx, model);
	publishCredits(ctx);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		active = isOpenRouter(ctx.model);

		// Session state is fresh here: in-memory tracking may belong to a previous session.
		request = undefined;
		displayedProvider = persistedState(ctx)?.provider;
		persistedProvider = displayedProvider;

		if (active) {
			// Show the last known balance immediately, then refresh in the background.
			credits ??= loadCache();
		}
		publishAll(ctx, ctx.model);
		refreshIfActive(ctx, true);

		if (timer) clearInterval(timer);
		timer = setInterval(() => refreshIfActive(ctx, true), POLL_MS);
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	});

	pi.on("model_select", async (event, ctx) => {
		const wasActive = active;
		active = isOpenRouter(event.model);
		if (active && !wasActive) {
			credits ??= loadCache();
			refreshIfActive(ctx, true);
		}
		publishAll(ctx, event.model);
	});

	// Costs land on turn_end: refresh (throttled) so the balance follows spending.
	pi.on("turn_end", async (_event, ctx) => refreshIfActive(ctx));

	pi.on("provider_stream_event", async (event, ctx) => {
		if (!isOpenRouter(event)) return;
		const data = event.data as Record<string, unknown> | undefined;
		if (!data || typeof data !== "object") return;

		const provider = typeof data.provider === "string" ? data.provider : undefined;
		if (!provider) return;

		const generationId = typeof data.id === "string" ? data.id : undefined;
		if (!request || request.generationId !== generationId) {
			request = {
				model: typeof data.model === "string" ? data.model : event.model,
				provider,
				generationId,
			};
			displayedProvider = provider;
			if (ctx.hasUI) ctx.ui.setStatus(UPSTREAM_STATUS_KEY, provider);
		}
	});

	pi.on("message_end", async (event) => {
		// Only the assistant message ends a request; a user or tool message must not
		// republish the provider that served the previous one.
		if (!request || event.message.role !== "assistant") return;
		displayedProvider = request.provider;
		if (persistedProvider !== request.provider) {
			persistedProvider = request.provider;
			pi.appendEntry<PersistedProvider>(UPSTREAM_STATE_TYPE, {
				provider: request.provider,
				model: request.model,
			});
		}
	});

	pi.registerCommand("credits", {
		description: "Show your OpenRouter wallet balance and usage",
		handler: async (_args, ctx) => {
			if (!(await apiKey(ctx))) {
				ctx.ui.notify("No OpenRouter key is configured for pi (environment, auth.json, or /login)", "warning");
				return;
			}
			await refresh(ctx, true);
			if (!credits) {
				ctx.ui.notify("Could not read OpenRouter credits", "error");
				return;
			}
			const usage = await fetchKeyUsage(ctx);
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
