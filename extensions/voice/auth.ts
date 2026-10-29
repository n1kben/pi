import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readStoredCredentialRaw, type ProviderPreset } from "./providers.ts";

/**
 * Credentials exactly as pi resolves them for its own requests: the sign-in
 * stored in `auth.json` (OAuth refreshed when it is close to expiring), then
 * provider environment variables, then `models.json` provider config.
 *
 * One extension-wide runtime, created on first use: it costs a few milliseconds
 * and never touches the network.
 */
export type ResolvedAuth = {
  apiKey?: string;
  headers?: Record<string, string>;
  /** A provider base URL configured in pi, which wins over the preset's. */
  baseUrl?: string;
  /** Human-readable origin, e.g. "OAuth" or "OPENROUTER_API_KEY". */
  source?: string;
};

let runtimePromise: Promise<ModelRuntime | undefined> | undefined;

function piRuntime(): Promise<ModelRuntime | undefined> {
  runtimePromise ??= ModelRuntime.create({
    refreshOnCreate: false,
    allowModelNetwork: false,
  }).catch(() => undefined);
  return runtimePromise;
}

/** Resolves without throwing; a missing credential is an undefined `apiKey`. */
export async function resolveAuth(preset: ProviderPreset): Promise<ResolvedAuth> {
  if (preset.id !== "custom") {
    const runtime = await piRuntime();
    if (runtime) {
      try {
        const result = await runtime.getAuth(preset.id);
        if (result?.auth.apiKey) {
          return {
            apiKey: result.auth.apiKey,
            ...(result.auth.headers ? { headers: result.auth.headers as Record<string, string> } : {}),
            ...(result.auth.baseUrl ? { baseUrl: result.auth.baseUrl } : {}),
            ...(result.source ? { source: result.source } : {}),
          };
        }
      } catch {
        // Fall through to the direct reads below.
      }
    }
  }

  // pi's provider list may not know this provider (custom endpoints, or an
  // older pi); fall back to the places pi itself reads from.
  for (const name of preset.apiKeyEnv) {
    const value = process.env[name]?.trim();
    if (value) return { apiKey: value, source: name };
  }
  const stored = readStoredCredentialRaw(preset);
  return stored ? { apiKey: stored, source: "auth.json" } : {};
}
