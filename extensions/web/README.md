# Web

Web search and page extraction for pi:

- `web_search` — [Brave Search API](https://api-dashboard.search.brave.com/), with an option to pull the top results as Markdown.
- `web_fetch` — fetch a URL and extract the main content as Markdown with [Defuddle](https://defuddle.md/), rendering in a headless browser when the page is a JavaScript shell.

Both tools are read-only and marked open-world, so a permission extension can gate them.

## Setup

```bash
cd ~/.pi/agent/extensions/web
npm install
npx playwright-core install chromium   # only needed on machines without Chrome
```

Put the API key in `~/.pi/agent/web.json`:

```json
{
  "braveApiKey": "BSA...",
  "country": "US",
  "count": 5
}
```

`BRAVE_API_KEY` is used when `web.json` has no key. `web_fetch` works without a key.

## `web_search`

| Parameter | Description |
|---|---|
| `query` | Search query |
| `count` | Results, 1–20 (default `count` from settings) |
| `freshness` | `pd`, `pw`, `pm`, `py`, or `YYYY-MM-DDtoYYYY-MM-DD` |
| `country` | Two-letter code, e.g. `DE` |
| `offset` | Result offset for paging, 0–9 |
| `fetch_content` | Also fetch the top results and include their Markdown |
| `content_count` | How many results to fetch, 1–5 (default 3) |
| `render` | `auto`, `http`, or `browser` for the content fetches |

Content fetches run three at a time and reuse the page cache, so repeated searches with `fetch_content` stay cheap.

## `web_fetch`

| Parameter | Description |
|---|---|
| `url` | Absolute http(s) URL |
| `render` | `auto` (default), `http`, or `browser` |
| `force` | Bypass the cache and refetch |
| `max_chars` | Cap the returned Markdown |
| `raw` | Return plain page text instead of Defuddle's extraction |

### How the page is extracted

1. Plain HTTP fetch with a browser User-Agent.
2. HTML → `linkedom` DOM → Defuddle → Markdown, metadata (title, author, published, site).
   - Defuddle sometimes returns empty Markdown while its cleaned content is intact. Markdown is then rebuilt locally with Turndown + GFM, unless the content is already Markdown (detected by headings or fences), in which case it is used as-is.
   - If the extraction is near-empty (under 25 words or 120 characters), a second relaxed pass disables Defuddle's boilerplate heuristics (`removeContentPatterns`, `removeLowScoring`, selector removal). This recovers listing and card-grid pages that look like navigation to the defaults.
   - Escaped brackets and link destinations are unescaped, and `data:` images and long base64 runs are dropped.
3. If the extraction is thin (fewer than `minWords` words or under 400 characters), or the site returned 401/403/429 to the plain fetch, the page is re-rendered in a headless browser and run through the same pipeline. The richer of the two results wins, so a cookie wall or client-rendered 404 cannot make things worse.
4. Pages that still extract fewer than 20 characters raise an error instead of returning an empty page, and a result under `minWords` carries a short-extraction notice.

Browser resolution order: `chrome` → `msedge` → Playwright's bundled `chromium`. On a VPS without Chrome, run `npx playwright-core install chromium` once (add `--with-deps` on a bare Linux box). Images, media, and fonts are blocked for a cheap render, and one browser is shared per session and closed on shutdown.

Non-HTML responses: plain text, Markdown, JSON, CSV, and XML are returned as-is; other content types (PDF, images) produce an actionable error instead of a partial extraction.

## Cache

Extracted pages are cached as JSON in `~/.pi/agent/web-cache/<sha256(url)>.json` for `cacheTtlMs` (24h by default). A stale entry is served with a note when a refetch fails, and the truncated-output notice points at the cache file when a page is longer than the output budget. `/web clear` empties it.

Extractions under `minWords` are not written to the cache, and cached entries below that threshold are ignored, so a render that did not settle cannot pin an empty page for the TTL.

Search results are not cached.

## Settings

`~/.pi/agent/web.json` overrides `config.ts`, which overrides the built-in defaults:

| Field | Default | Description |
|---|---|---|
| `braveApiKey` | — | Brave Search key; falls back to `BRAVE_API_KEY` |
| `count` | `5` | Default results per search |
| `country` | `US` | Default result country |
| `freshness` | — | Default time filter |
| `cacheDir` | `~/.pi/agent/web-cache` | Page cache directory |
| `cacheTtlHours` | `24` | Cache lifetime in hours (0 disables) |
| `maxChars` | `40000` | Output budget per tool result |
| `pageChars` | `6000` | Per-page budget in `fetch_content` |
| `minWords` | `80` | Thin-content threshold for browser escalation |
| `userAgent` | Chrome UA | User-Agent for plain fetches |
| `timeoutMs` | `15000` | Plain fetch timeout |
| `browserTimeoutMs` | `30000` | Browser navigation/load timeout |
| `render` | `auto` | Default render mode |
| `browserChannels` | `["chrome", "msedge"]` | Channels tried before bundled chromium |
| `headed` | `false` | Show the fallback browser window |

## Commands

- `/web` — key, cache, render, and budget status.
- `/web browser` — status plus a real render of `example.com`.
- `/web clear` — delete cached pages.

## Development

```bash
npm run check   # tsc --noEmit
```
