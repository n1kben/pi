/**
 * Working indicator presets.
 *
 * Pi animates a braille spinner before the working message. `setWorkingIndicator`
 * takes frames and an interval, and renders each frame verbatim, so a preset is
 * just a list of pre-painted strings: colors come from the theme at apply time, and
 * the gradient frames mix two theme tokens so a ramp follows the theme instead of
 * hard-coding RGB.
 *
 * /working            show the current preset and the list
 * /working <preset>   switch to a preset
 * /working default    hand the indicator back to Pi
 *
 * The choice lasts for the session; the default below is what starts.
 */
import { type ExtensionAPI, type ExtensionContext, type Theme, type ThemeColor } from "@mariozechner/pi-coding-agent";
import { foregroundAnsi, mixColors } from "@mariozechner/pi-tui";

const DEFAULT_PRESET = "glow";
const PREVIEW_KEY = "working-preview";
/** Long enough to judge the rhythm, short enough not to sit in the way. */
const PREVIEW_MS = 3500;
const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Frames of one preset, painted for the theme in use. */
interface Preset {
	intervalMs: number;
	frames(theme: Theme): string[];
}

/** A color partway from one theme token to another, reset after the glyph. */
function paint(theme: Theme, from: ThemeColor, to: ThemeColor, amount: number, text: string): string {
	const color = mixColors(theme.colors[from], theme.colors[to], amount, "oklch");
	return `${foregroundAnsi(color, theme.getColorMode())}${text}\x1b[39m`;
}

/** 0 at both ends, 1 in the middle: a breath that has no seam when the frames wrap. */
function breath(step: number, steps: number): number {
	return (1 - Math.cos((step / steps) * Math.PI * 2)) / 2;
}

/** 0 at both ends, 1 in the middle, evenly spaced: what a bar or a travelling peak wants. */
function triangle(step: number, steps: number): number {
	const half = (steps - 1) / 2;
	return 1 - Math.abs(step - half) / half;
}

const presets: Record<string, Preset> = {
	/** Pi's spinner, one frame quicker. */
	spin: {
		intervalMs: 70,
		frames: (theme) => BRAILLE.map((glyph) => theme.fg("accent", glyph)),
	},
	/** The spinner glyph, brightening and fading as it turns. */
	glow: {
		intervalMs: 90,
		frames: (theme) => BRAILLE.map((glyph, step) => paint(theme, "dim", "accent", breath(step, BRAILLE.length), glyph)),
	},
	/** One block swelling from a hairline to full and back. */
	bar: {
		intervalMs: 80,
		frames: (theme) => {
			const top = BLOCKS.length - 1;
			const steps = top * 2 + 1;
			return Array.from({ length: steps }, (_, step) => {
				const level = Math.round(triangle(step, steps) * top);
				return paint(theme, "dim", "accent", level / top, BLOCKS[level]!);
			});
		},
	},
	/** A block wave travelling across a short bar, each cell as tall as the wave there. */
	equalizer: {
		intervalMs: 90,
		frames: (theme) => {
			const cells = 6;
			const top = BLOCKS.length - 1;
			const steps = (cells - 1) * 2 + 1;
			return Array.from({ length: steps }, (_, step) => {
				// Whole-cell positions: a peak that lands between two cells rounds to one
				// of them and makes the wave stutter.
				const center = Math.round(triangle(step, steps) * (cells - 1));
				return Array.from({ length: cells }, (_, cell) => {
					const height = Math.max(0, 1 - Math.abs(cell - center) / 2);
					return paint(theme, "dim", "accent", height, BLOCKS[Math.round(height * top)]!);
				}).join("");
			});
		},
	},
	/** One dot filling and emptying. */
	dots: {
		intervalMs: 110,
		frames: (theme) => ["·", "•", "●", "•"].map((glyph) => theme.fg("accent", glyph)),
	},
	/** Three dots swelling in turn, the way a typing bubble does. */
	typing: {
		intervalMs: 100,
		frames: (theme) => {
			const dots = 3;
			const steps = 12;
			const sizes = ["·", "•", "●"];
			const top = sizes.length - 1;
			/** One dot swells at a time, and the swell walks left to right. */
			const swell = (step: number, dot: number): number => {
				// Each dot runs a window of one cycle divided by the dot count, a third of a
				// cycle behind the one before it.
				const phase = (((step + steps / 2 - (dot * steps) / dots) % steps) + steps) % steps;
				const distance = Math.abs(phase / steps - 0.5);
				return Math.max(0, 1 - distance * dots);
			};
			return Array.from({ length: steps }, (_, step) =>
				Array.from({ length: dots }, (_, dot) => {
					const amount = swell(step, dot);
					return paint(theme, "dim", "accent", amount, sizes[Math.round(amount * top)]!);
				}).join(" "),
			);
		},
	},
};

const names = Object.keys(presets).join(", ");

/**
 * Run the frames once under the editor, so a preset can be looked at without
 * waiting for a request. A widget is Pi's only place for moving content that is not
 * the working indicator itself, which only exists while a turn runs.
 */
function preview(preset: Preset, ctx: ExtensionContext): void {
	const frames = preset.frames(ctx.ui.theme);
	const message = ctx.ui.theme.fg("muted", "Working");
	const steps = Math.max(1, Math.round(PREVIEW_MS / preset.intervalMs));
	let step = 0;
	let timer: ReturnType<typeof setInterval> | undefined;

	const stop = (): void => {
		if (timer) clearInterval(timer);
		timer = undefined;
		try {
			ctx.ui.setWidget(PREVIEW_KEY, undefined);
		} catch {
			// The session was replaced under the timer; nothing left to clear.
		}
	};

	ctx.ui.setWidget(PREVIEW_KEY, (tui) => {
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			step += 1;
			if (step > steps) {
				stop();
				return;
			}
			tui.requestRender();
		}, preset.intervalMs);
		return {
			render: () => [` ${frames[step % frames.length] ?? ""} ${message}`],
			invalidate() {},
		};
	}, { placement: "aboveEditor" });
}

function apply(preset: string | undefined, ctx: ExtensionContext): boolean {
	if (preset === undefined) {
		ctx.ui.setWorkingIndicator();
		return true;
	}
	const chosen = presets[preset];
	if (!chosen) return false;
	ctx.ui.setWorkingIndicator({ frames: chosen.frames(ctx.ui.theme), intervalMs: chosen.intervalMs });
	return true;
}

export default function (pi: ExtensionAPI) {
	let current = DEFAULT_PRESET;

	pi.registerCommand("working", {
		description: `Choose the working indicator (${names}, default); "preview" plays one`,
		handler: async (args, ctx) => {
			const [choice, preset] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);

			if (choice === "preview") {
				const wanted = preset ?? (current === "default" ? DEFAULT_PRESET : current);
				const shown = presets[wanted];
				if (!shown) {
					ctx.ui.notify(`Unknown indicator: ${wanted}. Choose ${names}.`, "warning");
					return;
				}
				if (preset) {
					apply(preset, ctx);
					current = preset;
				}
				preview(shown, ctx);
				return;
			}

			if (choice === "") {
				ctx.ui.notify(`Working indicator: ${current}. Choose ${names}, default, or preview.`, "info");
				return;
			}
			if (choice !== "default" && !apply(choice, ctx)) {
				ctx.ui.notify(`Unknown indicator: ${choice}. Choose ${names}, default, or preview.`, "warning");
				return;
			}
			if (choice === "default") apply(undefined, ctx);
			current = choice;
			ctx.ui.notify(`Working indicator: ${current}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		apply(current === "default" ? undefined : current, ctx);
	});
}
