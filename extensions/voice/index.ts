import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Dictation } from "./dictation.ts";
import { readSettings, readSettingsSync, updateSettings } from "./settings.ts";
import { normalizeShortcut } from "./shortcut.ts";

/** One recorder per extension runtime: a reload gets a fresh one. */
type VoiceRuntime = { dictation: Dictation };

export default function piVoice(pi: ExtensionAPI): void {
  // Registration runs before any session, so the binding is read synchronously.
  const { settings, warning } = readSettingsSync();
  const registeredShortcut = normalizeShortcut(settings.shortcut) ?? "ctrl+space";

  let runtimePromise: Promise<VoiceRuntime> | undefined;
  let shuttingDown = false;

  function loadRuntime(): Promise<VoiceRuntime> {
    if (shuttingDown) return Promise.reject(new Error("Pi Voice is shutting down"));
    if (runtimePromise) return runtimePromise;
    const loading = import("./dictation.ts").then(
      ({ Dictation }) => ({ dictation: new Dictation() }),
    );
    runtimePromise = loading;
    void loading.catch(() => {
      if (runtimePromise === loading) runtimePromise = undefined;
    });
    return loading;
  }

  async function toggle(ctx: ExtensionContext): Promise<void> {
    try {
      await (await loadRuntime()).dictation.toggle(ctx);
    } catch (error) {
      // The native recorder is loaded lazily; a broken platform build lands here.
      ctx.ui.notify(`Voice unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  pi.registerShortcut(registeredShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
    description: "Toggle speech-to-text recording",
    handler: toggle,
  });

  pi.registerCommand("voice", {
    description: "Start or stop speech-to-text recording",
    handler: (_args, ctx) => toggle(ctx),
  });

  pi.registerCommand("voice-cancel", {
    description: "Discard the current voice recording",
    handler: async (_args, ctx) => (await loadRuntime()).dictation.cancel(ctx),
  });

  pi.registerCommand("voice-model", {
    description: "Pick the transcription model (/voice-model <id> to set it directly)",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const model = args.trim();
      if (model) {
        try {
          await updateSettings({ model });
          ctx.ui.notify(`Voice model set to ${model}.`, "info");
        } catch (error) {
          ctx.ui.notify(
            `Could not save the model: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
        return;
      }
      try {
        await (await import("./model-picker.ts")).pickModel(ctx);
      } catch (error) {
        ctx.ui.notify(
          `Could not load models: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Configured means usable: config.ts defaults count, so stay quiet unless
    // something is actually broken.
    if (warning) {
      ctx.ui.notify(warning, "warning");
      return;
    }
    if (!ctx.hasUI) return;
    const current = await readSettings();
    if (current.warning) {
      ctx.ui.notify(current.warning, "warning");
      return;
    }
    if (!current.settings.model) {
      ctx.ui.notify("Voice is missing a model. Set it in voice.json or run /voice-model.", "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    const loading = runtimePromise;
    if (!loading) return;
    const runtime = await loading.catch(() => undefined);
    await runtime?.dictation.dispose().catch(() => undefined);
  });
}
