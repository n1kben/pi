import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveAuth } from "./auth.ts";
import { listModels, presetFor } from "./providers.ts";
import { readSettings, updateSettings } from "./settings.ts";

/**
 * `/voice-model`: the one thing a config file cannot give you, since model ids
 * (and their per-second prices) are only discoverable from the provider.
 * Everything else lives in config.ts / voice.json.
 */
export async function pickModel(ctx: ExtensionCommandContext): Promise<void> {
  const { settings } = await readSettings();
  const preset = presetFor(settings.provider);
  const { apiKey } = await resolveAuth(preset, ctx.modelRegistry);
  const models = await listModels(preset, apiKey);

  if (models.length === 0) {
    ctx.ui.notify(
      `No models listed for ${preset.label}. Set "model" in ${preset.id === "custom" ? "voice.json" : "/voice-models"} and try again.`,
      "warning",
    );
    return;
  }

  const options = [
    ...models.map((model) => {
      const current = model.id === settings.model ? "  ← active" : "";
      return `${model.id}${model.note ? `  ${model.note}` : ""}${current}`;
    }),
    "Type a model id…",
  ];
  const choice = await ctx.ui.select(`${preset.label} transcription models`, options);
  if (!choice) return;

  const model =
    choice === "Type a model id…"
      ? (await ctx.ui.input("Model id", settings.model || preset.defaultModel))?.trim()
      : models[options.indexOf(choice)]!.id;
  if (!model) return;

  try {
    await updateSettings({ model });
  } catch (error) {
    ctx.ui.notify(
      `Could not save the model: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  ctx.ui.notify(`Voice model set to ${model}`, "info");
}
