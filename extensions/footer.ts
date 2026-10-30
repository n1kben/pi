import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatFolder(cwd: string): string {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	if (!trimmed) return cwd;
	return basename(trimmed) || trimmed;
}


function shellBlue(text: string): string {
	return `\x1b[34m${text}\x1b[39m`;
}

function shellGreen(text: string): string {
	return `\x1b[32m${text}\x1b[39m`;
}

/** The checkout's branch, which pi's footer data resolves and watches itself. */
function gitBranchText(footerData: ReadonlyFooterDataProvider): string {
	const branch = footerData.getGitBranch();
	return branch ? shellGreen(`(${branch})`) : "";
}

function contextUsageText(ctx: ExtensionContext, theme: Theme): string {
	const usage = ctx.getContextUsage();
	const tokens = usage?.tokens ?? null;
	const text = tokens === null ? "?" : formatTokens(tokens);

	if (tokens === null) return theme.fg("dim", text);
	if (tokens >= 100_000) return theme.fg("error", text);
	if (tokens >= 50_000) return theme.fg("warning", text);
	return theme.fg("muted", text);
}

/**
 * Model name only: drops the provider ("openrouter/") and the vendor namespace
 * inside the id ("deepseek/deepseek-v4.1-flash-1017" -> "deepseek-v4.1-flash-1017").
 */
function modelName(model: ExtensionContext["model"]): string {
	if (!model) return "?";
	const id = model.id ?? "";
	const leaf = id.split("/").filter(Boolean).at(-1) ?? id;
	return leaf || model.provider;
}

function thinkingLevelText(level: ThinkingLevel, theme: Theme): string {
	return theme.fg("muted", level);
}

// Rendered on the right next to the model instead of with the other statuses.
const UPSTREAM_STATUS_KEY = "openrouter-upstream";
const CREDITS_STATUS_KEY = "openrouter-credits";
const RIGHT_STATUS_KEYS = new Set([UPSTREAM_STATUS_KEY, CREDITS_STATUS_KEY]);

function extensionStatusesText(footerData: ReadonlyFooterDataProvider, theme: Theme): string {
	return [...footerData.getExtensionStatuses().entries()]
		.filter((entry): entry is [string, string] => Boolean(entry[1]) && !RIGHT_STATUS_KEYS.has(entry[0]))
		.map(([, text]) => text)
		.join(` ${theme.fg("muted", "·")} `);
}

function creditsText(footerData: ReadonlyFooterDataProvider, theme: Theme): string {
	const raw = footerData.getExtensionStatuses().get(CREDITS_STATUS_KEY);
	if (!raw) return "";
	const amount = Number(raw.replace(/[^0-9.]/g, ""));
	if (!Number.isFinite(amount)) return theme.fg("muted", raw);
	if (amount <= 0.5) return theme.fg("error", raw);
	if (amount <= 2) return theme.fg("warning", raw);
	return theme.fg("muted", raw);
}

/**
 * Upstream provider chosen by the router, e.g. "Parasail" -> "parasail".
 * Placeholder values ("–") are treated as unknown.
 */
function upstreamName(footerData: ReadonlyFooterDataProvider): string | undefined {
	const upstream = footerData.getExtensionStatuses().get(UPSTREAM_STATUS_KEY)?.trim();
	if (!upstream || !/[\p{L}\d]/u.test(upstream)) return undefined;
	return upstream.toLowerCase();
}

/** "parasail/deepseek-v4.1-flash-1017", or just the model when unknown. Colored as one muted chunk. */
function modelGroupText(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider, theme: Theme): string {
	const model = modelName(ctx.model);
	const upstream = upstreamName(footerData);
	const text = upstream ? `${upstream}/${model}` : model;
	return theme.fg(ctx.model ? "muted" : "dim", text);
}

function renderFooterLine(
	ctx: ExtensionContext,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	width: number,
	thinkingLevel: ThinkingLevel,
): string {
	if (width <= 0) return "";

	const ellipsis = theme.fg("dim", "...");
	const leftParts = [
		shellBlue(formatFolder(ctx.cwd)),
		gitBranchText(footerData),
		extensionStatusesText(footerData, theme),
	].filter(Boolean);
	const left = leftParts.join(" ");
	const credits = creditsText(footerData, theme);
	// Right side order: tokens, upstream/provider/model, thinking, cost last.
	const right = [
		contextUsageText(ctx, theme),
		modelGroupText(ctx, footerData, theme),
		thinkingLevelText(thinkingLevel, theme),
		credits,
	].filter(Boolean)
		.join(" ");
	const rightWidth = visibleWidth(right);

	if (rightWidth >= width) {
		return truncateToWidth(right, width, ellipsis);
	}

	const leftWidth = Math.max(0, width - rightWidth - 1);
	const visibleLeft = truncateToWidth(left, leftWidth, ellipsis);
	const padding = " ".repeat(Math.max(1, width - visibleWidth(visibleLeft) - rightWidth));

	return truncateToWidth(visibleLeft + padding + right, width, ellipsis);
}

export default function (pi: ExtensionAPI) {
	let requestFooterRender: (() => void) | undefined;

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const requestRender = () => tui.requestRender();
			requestFooterRender = requestRender;
			// Checkout changes (a rebase, a branch switch in another terminal) need no turn.
			const unsubscribeBranch = footerData.onBranchChange(requestRender);

			return {
				dispose() {
					unsubscribeBranch();
					if (requestFooterRender === requestRender) {
						requestFooterRender = undefined;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					return [renderFooterLine(ctx, theme, footerData, width, pi.getThinkingLevel())];
				},
			};
		});
	});

	pi.on("model_select", async () => requestFooterRender?.());
	pi.on("thinking_level_select", async () => requestFooterRender?.());
	pi.on("message_end", async () => requestFooterRender?.());
	pi.on("turn_end", async () => requestFooterRender?.());
}
