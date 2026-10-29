import { readFileSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaults as codeDefaults } from "./config.ts";
import { AGENT_DIR, presetFor } from "./providers.ts";
import { defaultShortcut, normalizeShortcut } from "./shortcut.ts";

const SETTINGS_VERSION = 1;

export type MicrophoneSetting =
  | { type: "system-default" }
  | { type: "device"; id: string; name: string };

export type VoiceSettings = {
  version: 1;
  /** Preset id from providers.ts ("openrouter", "openai", … or "custom"). */
  provider: string;
  /** Base URL of the OpenAI-compatible API; `/audio/transcriptions` is appended. */
  baseUrl: string;
  model: string;
  /** "auto" lets the model detect the language; otherwise an ISO-639-1 code. */
  language: string;
  /** Optional context or vocabulary passed to the model. */
  prompt: string;
  shortcut: string;
  microphone: MicrophoneSetting;
  insert: "paste" | "notify";
};

export function settingsPath(): string {
  return join(AGENT_DIR, "voice.json");
}

/** Built-in defaults with config.ts layered on top. */
export function defaultSettings(): VoiceSettings {
  const provider = typeof codeDefaults.provider === "string" ? codeDefaults.provider : "openrouter";
  const preset = presetFor(provider);
  return {
    version: SETTINGS_VERSION,
    provider,
    baseUrl: trimBaseUrl(codeDefaults.baseUrl) ?? preset.baseUrl,
    model: nonEmpty(codeDefaults.model) ?? preset.defaultModel,
    language: nonEmpty(codeDefaults.language) ?? "auto",
    prompt: typeof codeDefaults.prompt === "string" ? codeDefaults.prompt : "",
    shortcut:
      (codeDefaults.shortcut ? normalizeShortcut(codeDefaults.shortcut) : undefined) ?? defaultShortcut(),
    microphone: validateMicrophone(codeDefaults.microphone),
    insert: codeDefaults.insert === "notify" ? "notify" : "paste",
  };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function trimBaseUrl(value: unknown): string | undefined {
  return nonEmpty(value)?.replace(/\/+$/, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateMicrophone(value: unknown): MicrophoneSetting {
  if (isObject(value) && value.type === "device" && typeof value.id === "string") {
    return { type: "device", id: value.id, name: typeof value.name === "string" ? value.name : value.id };
  }
  return { type: "system-default" };
}

/**
 * Fills in anything missing or invalid instead of discarding the whole file, so a
 * hand-written partial file works. `version` is accepted but not required.
 */
export function validateSettings(value: unknown): VoiceSettings {
  const fallback = defaultSettings();
  if (!isObject(value)) return fallback;

  const provider = typeof value.provider === "string" ? value.provider : fallback.provider;
  const preset = presetFor(provider);
  const baseUrl = trimBaseUrl(value.baseUrl) ?? (provider === fallback.provider ? fallback.baseUrl : preset.baseUrl);
  const model = nonEmpty(value.model) ?? (provider === fallback.provider ? fallback.model : preset.defaultModel);

  return {
    version: SETTINGS_VERSION,
    provider,
    baseUrl,
    model,
    language: nonEmpty(value.language) ?? fallback.language,
    prompt: typeof value.prompt === "string" ? value.prompt : fallback.prompt,
    shortcut:
      (typeof value.shortcut === "string" ? normalizeShortcut(value.shortcut) : undefined) ??
      fallback.shortcut,
    microphone:
      value.microphone === undefined ? fallback.microphone : validateMicrophone(value.microphone),
    insert:
      value.insert === "notify" ? "notify" : value.insert === "paste" ? "paste" : fallback.insert,
  };
}

/** Synchronous read for shortcut registration, which happens before startup. */
export function readSettingsSync(): { settings: VoiceSettings; warning?: string } {
  const path = settingsPath();
  try {
    return { settings: validateSettings(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: defaultSettings() };
    return {
      settings: defaultSettings(),
      warning: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function readSettings(): Promise<{ settings: VoiceSettings; warning?: string }> {
  const path = settingsPath();
  try {
    return { settings: validateSettings(JSON.parse(await readFile(path, "utf8"))) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: defaultSettings() };
    return {
      settings: defaultSettings(),
      warning: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function writeSettingsFile(value: Record<string, unknown>): Promise<void> {
  const path = settingsPath();
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/** Keys of the file we own; anything else in it is left untouched. */
const SETTING_KEYS: ReadonlySet<string> = new Set([
  "version",
  "provider",
  "baseUrl",
  "model",
  "language",
  "prompt",
  "shortcut",
  "microphone",
  "insert",
]);

/**
 * Saves only the given fields into `voice.json`, keeping the rest of the file
 * as it is — the way pi's own `/settings` writes `settings.json`.
 *
 * Not persisting the whole resolved object matters: writing every field would
 * pin the current `config.ts` defaults into the file, so later code-level
 * changes to the untouched fields would stop applying.
 */
export async function updateSettings(
  patch: Partial<Pick<VoiceSettings, "provider" | "baseUrl" | "model" | "language" | "prompt" | "shortcut" | "microphone" | "insert">>,
): Promise<VoiceSettings> {
  const path = settingsPath();
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable: start from an empty file.
  }

  const next: Record<string, unknown> = { ...current, version: SETTINGS_VERSION };
  for (const [key, value] of Object.entries(patch)) {
    if (SETTING_KEYS.has(key) && value !== undefined) next[key] = value;
  }
  await writeSettingsFile(next);
  return validateSettings(next);
}
