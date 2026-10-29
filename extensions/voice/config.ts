import type { VoiceSettings } from "./settings.ts";

/**
 * Code-level defaults for this checkout of the extension.
 *
 * Edit this to make the extension yours: anything set here applies to every
 * session without touching a config file. Values in `voice.json` (which also
 * wins) override these, and these override the built-in defaults.
 *
 * Precedence: built-in defaults → this file → `~/.pi/agent/voice.json`.
 *
 * `/reload` (or a restart) applies changes to the shortcut; the rest is read
 * per recording.
 *
 * Fields (all optional):
 *
 * - `provider`: `openrouter`, `openai`, `groq`, `mistral`, or `custom`
 * - `baseUrl`: API root; `/audio/transcriptions` is appended
 * - `model`: model id, e.g. `openai/gpt-transcribe`
 * - `language`: `auto` or an ISO-639-1 code, e.g. `en`
 * - `prompt`: vocabulary or context sent with every request
 * - `shortcut`: binding for recording; leaving it out keeps the platform default
 *   (`ctrl+space`, or `ctrl+alt+z` where Ctrl+Space switches input sources)
 * - `insert`: `paste` into the editor or `notify` instead
 * - `microphone`: `{ type: "system-default" }` or `{ type: "device", id, name }`
 *
 * API keys are not here: the extension uses your pi sign-in (or the provider's
 * environment variable), so this file stays safe to commit.
 */
export const defaults: Partial<VoiceSettings> = {
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "openai/gpt-transcribe",
  language: "auto",
};
