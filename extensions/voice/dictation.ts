import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  describeCaptureError,
  microphonePermission,
  openMicrophone,
  SAMPLE_RATE,
  type Capture,
} from "./audio.ts";
import { resolveAuth } from "./auth.ts";
import { apiKeyHint, presetFor } from "./providers.ts";
import { readSettings, type VoiceSettings } from "./settings.ts";
import { displayShortcut } from "./shortcut.ts";
import { transcribeAudio, TranscriptionError } from "./stt.ts";

const WIDGET_KEY = "voice";
const COMPLETION_WIDGET_MS = 5_000;
const METER_FRAMES = " ▁▂▃▄▅▆▇█";

type Active = {
  capture?: Capture;
  cancelled: boolean;
  chunks: number;
  bytes: number;
  startedAt: number;
  timer?: ReturnType<typeof setInterval>;
  level: number;
  failure?: Error;
};

function seconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1);
}

function clock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function describeTranscriptionError(error: unknown, settings: VoiceSettings): string {
  if (error instanceof TranscriptionError) {
    const preset = presetFor(settings.provider);
    if (error.status === 401 || error.status === 403) {
      return `Transcription was rejected (${error.status}): ${error.message} ${apiKeyHint(preset)}`;
    }
    if (error.status === 402) return `Out of credits for ${preset.label}: ${error.message}`;
    if (error.status === 404) {
      return `Model "${settings.model}" is not available: ${error.message} Pick another with /voice-model.`;
    }
    return `Transcription failed: ${error.message}`;
  }
  return `Transcription failed: ${error instanceof Error ? error.message : String(error)}`;
}

/** Owns the one recording at a time, its status widget, and the paste-back. */
export class Dictation {
  private active: Active | undefined;
  private transcribing: AbortController | undefined;
  private completionTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  /** The shortcut and /voice both land here: start when idle, stop when recording. */
  async toggle(ctx: ExtensionContext): Promise<void> {
    if (this.disposed) return;
    if (this.active) {
      await this.finish(ctx);
      return;
    }
    await this.begin(ctx);
  }

  private setWidget(ctx: ExtensionContext, lines: string[] | undefined): void {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
  }

  private render(ctx: ExtensionContext, shortcut: string): void {
    const active = this.active;
    if (!active) return;
    const theme = ctx.ui.theme;
    const elapsed = clock(performance.now() - active.startedAt);
    const bar = active.cancelled
      ? ""
      : `${METER_FRAMES[Math.min(METER_FRAMES.length - 1, Math.round(active.level * (METER_FRAMES.length - 1)))]}`;
    const hint = theme.fg("dim", `  ${displayShortcut(shortcut)} stops`);
    this.setWidget(ctx, [
      `${theme.fg("error", "●")} ${theme.fg("text", `Recording ${elapsed}`)} ${theme.fg("accent", bar)}${hint}`,
    ]);
  }

  private async begin(ctx: ExtensionContext): Promise<void> {
    const { settings, warning } = await readSettings();
    if (warning) ctx.ui.notify(warning, "warning");

    const preset = presetFor(settings.provider);
    const { apiKey } = await resolveAuth(preset);
    if (!apiKey && preset.id !== "custom") {
      ctx.ui.notify(`Voice is not signed in to ${preset.label}. ${apiKeyHint(preset)}`, "error");
      return;
    }
    if (process.platform === "darwin" && microphonePermission() === "denied") {
      ctx.ui.notify(
        "Microphone access is denied. Allow your terminal app in System Settings → Privacy & Security → Microphone, then try again.",
        "error",
      );
      return;
    }

    const active: Active = {
      cancelled: false,
      chunks: 0,
      bytes: 0,
      startedAt: performance.now(),
      level: 0,
    };
    this.active = active;
    this.setWidget(ctx, [ctx.ui.theme.fg("muted", "Starting microphone…")]);

    let capture: Capture;
    try {
      capture = await openMicrophone(
        settings.microphone,
        (samples) => {
          if (this.active !== active) return;
          active.chunks++;
          active.bytes += samples.length;
          let sum = 0;
          for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
          const rms = Math.sqrt(sum / Math.max(1, samples.length));
          active.level = Math.min(1, rms * 8);
        },
        (error) => {
          if (this.active === active) active.failure = error;
        },
      );
    } catch (error) {
      this.active = undefined;
      this.setWidget(ctx, undefined);
      ctx.ui.notify(describeCaptureError(error), "error");
      return;
    }

    if (this.disposed || this.active !== active || active.cancelled) {
      // Stop was pressed while the device was still opening.
      await capture.stop().catch(() => undefined);
      return;
    }

    active.capture = capture;
    active.startedAt = performance.now();
    active.timer = setInterval(() => this.render(ctx, settings.shortcut), 200);
    this.render(ctx, settings.shortcut);
  }

  private async finish(ctx: ExtensionContext): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    if (active.timer) clearInterval(active.timer);
    active.cancelled = true;
    if (!active.capture) {
      // The microphone is still opening; begin() releases it when it resolves.
      this.setWidget(ctx, undefined);
      return;
    }

    this.setWidget(ctx, [ctx.ui.theme.fg("accent", "Transcribing…")]);
    const { settings } = await readSettings();

    let pcm: Float32Array;
    let interruption: Error | undefined;
    let dropped = 0;
    try {
      const captured = await active.capture.stop();
      pcm = captured.pcm;
      interruption = captured.interruption ?? active.failure;
      dropped = captured.droppedFrames ?? 0;
    } catch (error) {
      this.setWidget(ctx, undefined);
      ctx.ui.notify(describeCaptureError(error), "error");
      return;
    }

    if (pcm.length === 0) {
      this.setWidget(ctx, undefined);
      ctx.ui.notify(
        interruption
          ? `Nothing was recorded: ${interruption.message}`
          : "Nothing was recorded. Check the microphone in voice.json.",
        "warning",
      );
      return;
    }

    const spokenSeconds = pcm.length / SAMPLE_RATE;
    const startedAt = performance.now();
    const abort = new AbortController();
    this.transcribing = abort;
    try {
      const result = await transcribeAudio(pcm, settings, { signal: abort.signal });
      if (this.disposed) return;
      const tookSeconds = (performance.now() - startedAt) / 1000;

      if (!result.text) {
        this.setWidget(ctx, undefined);
        ctx.ui.notify(`No speech detected in ${seconds(spokenSeconds * 1000)}s of audio.`, "warning");
        return;
      }

      if (settings.insert === "notify") ctx.ui.notify(result.text, "info");
      else ctx.ui.pasteToEditor(result.text);

      const cost = result.cost === undefined ? "" : ` · $${result.cost.toFixed(5)}`;
      this.showCompletion(
        ctx,
        `${ctx.ui.theme.fg("success", "✓")} ${ctx.ui.theme.fg("muted", `${seconds(spokenSeconds * 1000)}s audio in ${seconds(tookSeconds * 1000)}s · ${settings.model}${cost}`)}`,
      );

      if (dropped > 0) {
        ctx.ui.notify(`${(dropped / SAMPLE_RATE).toFixed(2)}s of audio was lost while recording.`, "warning");
      }
      if (interruption) {
        ctx.ui.notify(
          `The microphone stopped after ${seconds(spokenSeconds * 1000)}s (${interruption.message}); everything up to then was transcribed.`,
          "warning",
        );
      }
    } catch (error) {
      if (this.disposed) return;
      this.setWidget(ctx, undefined);
      ctx.ui.notify(describeTranscriptionError(error, settings), "error");
    } finally {
      if (this.transcribing === abort) this.transcribing = undefined;
    }
  }

  private showCompletion(ctx: ExtensionContext, line: string): void {
    this.setWidget(ctx, [line]);
    if (this.completionTimer) clearTimeout(this.completionTimer);
    const timer = setTimeout(() => {
      if (this.completionTimer !== timer) return;
      this.completionTimer = undefined;
      this.setWidget(ctx, undefined);
    }, COMPLETION_WIDGET_MS);
    this.completionTimer = timer;
  }

  /** Discards the recording without transcribing it. */
  async cancel(ctx: ExtensionContext): Promise<void> {
    const active = this.active;
    this.transcribing?.abort();
    this.transcribing = undefined;
    if (!active) return;
    this.active = undefined;
    active.cancelled = true;
    if (active.timer) clearInterval(active.timer);
    await active.capture?.stop().catch(() => undefined);
    this.setWidget(ctx, undefined);
    ctx.ui.notify("Recording discarded", "info");
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.completionTimer = undefined;
    this.transcribing?.abort();
    this.transcribing = undefined;
    const active = this.active;
    this.active = undefined;
    if (active) {
      active.cancelled = true;
      if (active.timer) clearInterval(active.timer);
      await active.capture?.stop().catch(() => undefined);
    }
  }
}
