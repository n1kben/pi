import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveAuth } from "./auth.ts";
import { SAMPLE_RATE } from "./audio.ts";
import { presetFor } from "./providers.ts";
import type { VoiceSettings } from "./settings.ts";

export type Transcript = {
  text: string;
  /** Seconds of audio the provider billed for, when it reports it. */
  seconds?: number;
  cost?: number;
};

/** Float32 mono samples at 16 kHz into a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

export class TranscriptionError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "TranscriptionError";
    this.status = status;
  }
}

type TranscribeOptions = {
  /** pi's model runtime, which resolves the provider key the way a model request would. */
  registry: ModelRegistry;
  signal?: AbortSignal;
  /** Overrides the configured language (used by the settings test). */
  language?: string;
};

/**
 * Posts the recording to the configured OpenAI-compatible
 * `/audio/transcriptions` endpoint and returns its transcript.
 */
export async function transcribeAudio(
  pcm: Float32Array,
  settings: VoiceSettings,
  options: TranscribeOptions,
): Promise<Transcript> {
  if (!settings.baseUrl) {
    throw new TranscriptionError("No base URL configured. Set provider/baseUrl in voice.json.");
  }
  if (!settings.model) {
    throw new TranscriptionError("No transcription model configured. Set model in voice.json or run /voice-model.");
  }

  const wav = encodeWav(pcm);
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  form.append("model", settings.model);
  form.append("response_format", "json");
  const language = options.language ?? settings.language;
  if (language && language !== "auto") form.append("language", language);
  if (settings.prompt.trim()) form.append("prompt", settings.prompt.trim());

  const preset = presetFor(settings.provider);
  const auth = await resolveAuth(preset, options.registry);
  // A base URL pinned in pi's provider config wins, unless the user pointed the
  // preset somewhere else in voice.json.
  const configuredElsewhere = settings.baseUrl !== preset.baseUrl;
  const baseUrl = ((configuredElsewhere ? settings.baseUrl : auth.baseUrl) || settings.baseUrl).replace(
    /\/+$/,
    "",
  );
  const url = `${baseUrl}/audio/transcriptions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: authHeaders(settings, auth.apiKey, auth.headers),
      body: form,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Transcription cancelled");
    throw new TranscriptionError(
      `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const body = await response.text();
  if (!response.ok) throw new TranscriptionError(errorMessage(body, response.status), response.status);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Some servers answer with the bare transcript.
    return { text: body.trim() };
  }
  if (typeof parsed === "string") return { text: parsed.trim() };
  if (!parsed || typeof parsed !== "object") return { text: "" };

  const result = parsed as {
    text?: unknown;
    usage?: { seconds?: unknown; cost?: unknown };
  };
  const usage = result.usage ?? {};
  return {
    text: typeof result.text === "string" ? result.text.trim() : "",
    ...(typeof usage.seconds === "number" ? { seconds: usage.seconds } : {}),
    ...(typeof usage.cost === "number" ? { cost: usage.cost } : {}),
  };
}

function authHeaders(
  settings: VoiceSettings,
  apiKey: string | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (presetFor(settings.provider).id === "openrouter") {
    // OpenRouter attributes usage to the app that made the request.
    headers["HTTP-Referer"] = "https://pi.dev";
    headers["X-Title"] = "Pi Voice";
  }
  return headers;
}

function errorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.error?.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON: fall through to the raw body.
  }
  const trimmed = body.trim();
  return trimmed ? `${status}: ${trimmed.slice(0, 400)}` : `Transcription failed with HTTP ${status}`;
}
