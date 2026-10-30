import { readStoredCredential, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ProviderPreset } from "./providers.ts";

/**
 * Credentials exactly as pi resolves them for its own requests: the sign-in
 * stored in `auth.json` (OAuth refreshed when it is close to expiring), then
 * provider environment variables, then `models.json` provider config.
 *
 * `ctx.modelRegistry` is the runtime pi already built, so asking it costs no
 * startup work and sees `/login` and `!command` keys the same way a model
 * request would.
 */
export type ResolvedAuth = {
  apiKey?: string;
  headers?: Record<string, string>;
  /** A provider base URL configured in pi, which wins over the preset's. */
  baseUrl?: string;
  /** Human-readable origin, e.g. "OAuth" or "OPENROUTER_API_KEY". */
  source?: string;
};

/** Resolves without throwing; a missing credential is an undefined `apiKey`. */
export async function resolveAuth(preset: ProviderPreset, registry: ModelRegistry): Promise<ResolvedAuth> {
  if (preset.id !== "custom") {
    try {
      const result = await registry.getProviderAuth(preset.id);
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

  // pi's provider list may not know this provider (custom endpoints, or an
  // older pi); fall back to the places pi itself reads from.
  for (const name of preset.apiKeyEnv) {
    const value = process.env[name]?.trim();
    if (value) return { apiKey: value, source: name };
  }
  const stored = preset.authKey ? storedKey(readStoredCredential(preset.authKey)) : undefined;
  return stored ? { apiKey: stored, source: "auth.json" } : {};
}

/** `api_key` and OAuth credentials, plus the plain-string shape older files used. */
function storedKey(credential: unknown): string | undefined {
  if (typeof credential === "string") return credential.trim() || undefined;
  if (!credential || typeof credential !== "object") return undefined;

  const entry = credential as Record<string, unknown>;
  for (const field of ["key", "access", "apiKey"]) {
    const value = entry[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
