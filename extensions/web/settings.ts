import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaults } from "./config.ts";

export type RenderMode = "auto" | "http" | "browser";

export interface WebSettings {
  /** Brave Search API key. Falls back to BRAVE_API_KEY when `web.json` has none. */
  braveApiKey?: string;
  /** Default number of search results. */
  count: number;
  /** Two-letter country code for search results. */
  country: string;
  /** Default freshness filter: pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD. */
  freshness?: string;
  /** Where fetched pages are cached. */
  cacheDir: string;
  /** Cache lifetime; 0 disables reading the cache. */
  cacheTtlMs: number;
  /** Output budget for one tool result, in characters. */
  maxChars: number;
  /** Per-page budget for search results fetched with `fetch_content`. */
  pageChars: number;
  /** Extracted text below this word count is treated as JS-thin and re-rendered. */
  minWords: number;
  userAgent: string;
  timeoutMs: number;
  browserTimeoutMs: number;
  render: RenderMode;
  /** Browser channels tried in order before the Playwright-bundled chromium. */
  browserChannels: string[];
  headed: boolean;
}

export interface SettingsResult {
  settings: WebSettings;
  warning?: string;
}

const base: WebSettings = {
  count: 5,
  country: "US",
  cacheDir: join(homedir(), ".pi", "agent", "web-cache"),
  cacheTtlMs: 24 * 60 * 60 * 1000,
  maxChars: 40000,
  pageChars: 6000,
  minWords: 80,
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  timeoutMs: 15000,
  browserTimeoutMs: 30000,
  render: "auto",
  browserChannels: ["chrome", "msedge"],
  headed: false,
};

export function configPath(): string {
  return process.env.PI_WEB_CONFIG ?? join(homedir(), ".pi", "agent", "web.json");
}

type ConfigFile = Partial<Omit<WebSettings, "cacheDir" | "cacheTtlMs">> & {
  cacheDir?: string;
  cacheTtlHours?: number;
};

function readConfig(): { config: ConfigFile; warning?: string } {
  const path = configPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { config: {} } : { config: {}, warning: `Could not read ${path}: ${message(error)}` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("expected a JSON object");
    return { config: parsed as ConfigFile };
  } catch (error) {
    return { config: {}, warning: `Invalid JSON in ${path}: ${message(error)}` };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve settings for a tool call.
 *
 * Precedence: built-in defaults → `config.ts` → `web.json`. The API key comes
 * from `web.json` first and then from `BRAVE_API_KEY`, so a key pasted into the
 * config file is not silently shadowed by a stale shell export.
 */
export function readSettings(): SettingsResult {
  const { config, warning } = readConfig();
  const merged: WebSettings = { ...base, ...defaults, ...config } as WebSettings;

  if (typeof config.cacheTtlHours === "number") {
    merged.cacheTtlMs = Math.max(0, config.cacheTtlHours) * 60 * 60 * 1000;
  }
  merged.count = clamp(merged.count, 1, 20);
  merged.maxChars = clamp(merged.maxChars, 2000, 400000);
  merged.pageChars = clamp(merged.pageChars, 500, merged.maxChars);
  merged.minWords = clamp(merged.minWords, 0, 5000);
  merged.timeoutMs = clamp(merged.timeoutMs, 1000, 120000);
  merged.browserTimeoutMs = clamp(merged.browserTimeoutMs, 1000, 180000);
  merged.country = String(merged.country || "US").toUpperCase();

  const key = (config.braveApiKey ?? merged.braveApiKey ?? process.env.BRAVE_API_KEY)?.trim();
  merged.braveApiKey = key ? key : undefined;

  const notices = [warning];
  if (!merged.braveApiKey) {
    notices.push(
      `Brave Search has no API key. Add "braveApiKey" to ${configPath()} (or export BRAVE_API_KEY); web_fetch works without it.`,
    );
  }
  const result: SettingsResult = { settings: merged };
  const text = notices.filter(Boolean).join(" ");
  if (text) result.warning = text;
  return result;
}

function clamp(value: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}
