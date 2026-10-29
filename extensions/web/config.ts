import type { WebSettings } from "./settings.ts";

/**
 * Code-level defaults for this checkout of the extension.
 *
 * Edit this to make the extension yours: anything set here applies to every
 * session without touching a config file. Values in `~/.pi/agent/web.json`
 * override these, and these override the built-in defaults.
 *
 * Precedence: built-in defaults → this file → `~/.pi/agent/web.json`.
 *
 * Fields (all optional):
 *
 * - `braveApiKey`: Brave Search API key; `BRAVE_API_KEY` is used when this and
 *   `web.json` have none
 * - `count`: default number of results (1-20)
 * - `country`: two-letter country code for results, e.g. `US`
 * - `freshness`: `pd`, `pw`, `pm`, `py`, or `YYYY-MM-DDtoYYYY-MM-DD`
 * - `cacheDir`: page cache directory, defaults to `~/.pi/agent/web-cache`
 * - `cacheTtlMs`: cache lifetime in milliseconds, `0` disables reads
 * - `maxChars`: output budget per tool result
 * - `pageChars`: per-page budget when search results include content
 * - `minWords`: extracted text under this word count is treated as JS-thin and
 *   re-rendered in a browser
 * - `userAgent`: User-Agent for plain HTTP fetches
 * - `timeoutMs`: plain HTTP fetch timeout
 * - `browserTimeoutMs`: Playwright navigation and load timeout
 * - `render`: `auto` (HTTP, then browser when thin), `http`, or `browser`
 * - `browserChannels`: browser channels tried in order, e.g. `["chrome"]`
 * - `headed`: run the fallback browser with a visible window
 */
export const defaults: Partial<WebSettings> = {};
