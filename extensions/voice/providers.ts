import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/** One speech-to-text backend. Adding a provider means adding a preset. */
export type ProviderPreset = {
  id: string;
  label: string;
  baseUrl: string;
  /** Environment variables checked, in order, for the API key. */
  apiKeyEnv: string[];
  /** Entry in ~/.pi/agent/auth.json holding the same key. */
  authKey?: string;
  defaultModel: string;
  /** Used when the provider has no list endpoint, or the request fails. */
  models?: string[];
  /** JSON list endpoint; only OpenRouter filters it to speech-to-text models. */
  modelsUrl?: string;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: ["OPENROUTER_API_KEY"],
    authKey: "openrouter",
    defaultModel: "openai/gpt-transcribe",
    models: [
      "openai/gpt-transcribe",
      "openai/gpt-4o-transcribe",
      "openai/gpt-4o-mini-transcribe",
      "openai/whisper-large-v3",
      "mistralai/voxtral-mini-3b-2507",
      "deepgram/nova-3",
      "elevenlabs/scribe-v2",
    ],
    modelsUrl: "https://openrouter.ai/api/v1/models?output_modalities=transcription",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    authKey: "openai",
    defaultModel: "gpt-4o-transcribe",
    models: ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"],
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: ["GROQ_API_KEY"],
    authKey: "groq",
    defaultModel: "whisper-large-v3-turbo",
    models: ["whisper-large-v3-turbo", "whisper-large-v3", "distil-whisper-large-v3-en"],
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: ["MISTRAL_API_KEY"],
    authKey: "mistral",
    defaultModel: "voxtral-mini-latest",
    models: ["voxtral-mini-latest"],
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    baseUrl: "",
    apiKeyEnv: ["STT_API_KEY", "VOICE_API_KEY"],
    defaultModel: "",
  },
];

export function presetFor(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? PROVIDER_PRESETS[0]!;
}

export function providerLabel(id: string): string {
  return presetFor(id).label;
}

function resolveKeyValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    // `!command` keys are resolved by pi itself; don't try to run them here.
    return value && !value.startsWith("!") ? value : undefined;
  }
  if (value && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    for (const field of ["access", "key", "apiKey"]) {
      const candidate = resolveKeyValue(entry[field]);
      if (candidate) return candidate;
    }
  }
  return undefined;
}

/**
 * The credential pi stores for that provider, read straight from `auth.json`.
 * `resolveAuth` in auth.ts asks pi first and only lands here as a fallback.
 */
export function readStoredCredentialRaw(preset: ProviderPreset): string | undefined {
  if (!preset.authKey) return undefined;
  try {
    const auth = JSON.parse(readFileSync(join(AGENT_DIR, "auth.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return resolveKeyValue(auth[preset.authKey]);
  } catch {
    return undefined;
  }
}

export function apiKeyHint(preset: ProviderPreset): string {
  return `Sign in to ${preset.label} in pi (/login), set ${preset.apiKeyEnv[0]}, or store a key for "${preset.authKey ?? preset.id}" in ${join(AGENT_DIR, "auth.json")}.`;
}

export type ModelOption = { id: string; note?: string };

type OpenRouterModel = {
  id?: string;
  name?: string;
  pricing?: { prompt?: string };
};

/** Speech-to-text models the provider offers, cheapest note where it is known. */
export async function listModels(
  preset: ProviderPreset,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<ModelOption[]> {
  if (preset.modelsUrl) {
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(preset.modelsUrl, { headers, signal });
      if (response.ok) {
        const body = (await response.json()) as { data?: OpenRouterModel[] };
        const models = (body.data ?? [])
          .flatMap((model) => (model.id ? [{ id: model.id, note: priceNote(model) }] : []))
          .sort((a, b) => a.id.localeCompare(b.id));
        if (models.length > 0) return models;
      }
    } catch {
      // Fall through to the static list.
    }
  }
  return (preset.models ?? []).map((id) => ({ id }));
}

function priceNote(model: OpenRouterModel): string | undefined {
  const perSecond = Number(model.pricing?.prompt);
  if (!Number.isFinite(perSecond) || perSecond <= 0) return undefined;
  // Speech-to-text prices are quoted per second of audio.
  return `$${perSecond.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}/s`;
}
