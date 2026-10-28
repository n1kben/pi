/**
 * OpenRouter upstream provider indicator.
 *
 * OpenRouter picks an upstream provider per request (nitro = fastest). Pi's
 * catalog model ID and pricing don't show which one served you, so this
 * extension reads the `provider` field from OpenRouter's stream and surfaces it:
 *
 *   - footer:      "Together" next to the model (muted)
 *   - /upstream:  last 10 requests (provider, time, generation id)
 *   - log:        ~/.pi/agent/openrouter-upstream.log (JSONL)
 *
 * The footer value is session-scoped: the last provider is stored as a custom
 * session entry, so /reload restores this conversation's provider instead of
 * whatever happened to be last in the (shared) log.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG = join(homedir(), ".pi", "agent", "openrouter-upstream.log");
const STATUS_KEY = "openrouter-upstream";
const STATE_TYPE = "openrouter-upstream";
const HISTORY = 10;

interface Entry {
	at: string;
	model: string;
	provider: string;
	generationId?: string;
	cost?: number;
	promptTokens?: number;
	completionTokens?: number;
	cachedTokens?: number;
	ttftMs?: number;
	durationMs?: number;
}

let current: Entry | undefined;
let logged = false;
let requestStartedAt: number | undefined;
/** Last provider seen in this session; survives /reload via the session entry. */
let displayedProvider: string | undefined;
/** Provider already written to the session, to avoid one entry per turn. */
let persistedProvider: string | undefined;

function record(entry: Entry): void {
	try {
		appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
	} catch {
		// Logging must never break a request.
	}
}

interface PersistedState {
	provider: string;
	model: string;
}

/** Latest provider recorded on this session's current branch, if any. */
function persistedState(ctx: ExtensionContext): PersistedState | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
		const data = entry.data as Partial<PersistedState> | undefined;
		if (data && typeof data.provider === "string") return data as PersistedState;
	}
	return undefined;
}

/**
 * Pi clears extension statuses whenever the runtime is reloaded, so the indicator
 * must be re-published on every session_start (which also fires on /reload).
 * In-memory state is gone at that point, so the last provider is restored from
 * this session's own entries — never from the log, which all sessions share.
 */
function syncStatus(ctx: ExtensionContext, model: ExtensionContext["model"]): void {
	if (model?.provider !== "openrouter") {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, displayedProvider ?? "–");
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", async () => {
		requestStartedAt = Date.now();
	});

	pi.on("provider_stream_event", async (event, ctx) => {
		if (event.provider !== "openrouter") return;
		const data = event.data as Record<string, unknown> | undefined;
		if (!data || typeof data !== "object") return;

		const provider = typeof data.provider === "string" ? data.provider : undefined;
		if (!provider) return;

		const generationId = typeof data.id === "string" ? data.id : undefined;
		if (!current || current.generationId !== generationId) {
			current = {
				at: new Date().toISOString(),
				model: typeof data.model === "string" ? data.model : event.model,
				provider,
				generationId,
			};
			logged = false;
			if (requestStartedAt !== undefined) current.ttftMs = Date.now() - requestStartedAt;
			displayedProvider = provider;
			ctx.ui.setStatus(STATUS_KEY, provider);
		}

		const usage = data.usage as Record<string, unknown> | undefined;
		if (usage && typeof usage === "object") {
			if (typeof usage.cost === "number") current.cost = usage.cost;
			if (typeof usage.prompt_tokens === "number") current.promptTokens = usage.prompt_tokens;
			if (typeof usage.completion_tokens === "number") current.completionTokens = usage.completion_tokens;
			const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
			if (details && typeof details.cached_tokens === "number") current.cachedTokens = details.cached_tokens;
		}
	});

	pi.on("message_end", async () => {
		if (!current || logged) return;
		logged = true;
		if (requestStartedAt !== undefined) current.durationMs = Date.now() - requestStartedAt;
		record(current);
		displayedProvider = current.provider;
		if (persistedProvider !== current.provider) {
			persistedProvider = current.provider;
			pi.appendEntry<PersistedState>(STATE_TYPE, { provider: current.provider, model: current.model });
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		// Session state is fresh here: in-memory tracking may belong to a previous session.
		current = undefined;
		logged = false;
		requestStartedAt = undefined;
		displayedProvider = persistedState(ctx)?.provider;
		persistedProvider = displayedProvider;
		syncStatus(ctx, ctx.model);
	});

	pi.on("model_select", async (event, ctx) => {
		syncStatus(ctx, event.model);
	});

	pi.registerCommand("upstream", {
		description: "Show the upstream providers OpenRouter used recently",
		handler: async (_args, ctx) => {
			let lines: string[] = [];
			try {
				lines = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).slice(-HISTORY);
			} catch {
				ctx.ui.notify(`No requests logged yet (${LOG})`, "info");
				return;
			}
			if (lines.length === 0) {
				ctx.ui.notify(`No requests logged yet (${LOG})`, "info");
				return;
			}
			const rows = lines.map((line) => {
				try {
					const e = JSON.parse(line) as Entry;
					const time = e.at.slice(11, 19);
					const cost = typeof e.cost === "number" ? ` $${e.cost.toFixed(6)}` : "";
					const timing =
						typeof e.ttftMs === "number"
							? ` ttft ${e.ttftMs}ms/${typeof e.durationMs === "number" ? e.durationMs : "?"}ms`
							: "";
					return `${time}  ${e.provider.padEnd(12)} ${e.model}${timing}${cost}`;
				} catch {
					return line;
				}
			});
			ctx.ui.notify(`Recent OpenRouter upstreams\n${rows.join("\n")}`, "info");
		},
	});
}
