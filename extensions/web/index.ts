import { formatSize, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { clearCache, readCache, writeCache } from "./cache.ts";
import { closeBrowser, renderPage } from "./browser.ts";
import { fetchPage, FetchError, type Page } from "./extract.ts";
import { braveSearch, type SearchResult } from "./search.ts";
import { readSettings, configPath, type RenderMode, type WebSettings } from "./settings.ts";

const RenderEnum = Type.Optional(
  Type.String({
    enum: ["auto", "http", "browser"],
    description:
      "How to load the page. auto (default) fetches over HTTP and re-renders in a browser when the page is a JS shell; http never renders; browser always renders.",
  }),
);

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query" }),
  count: Type.Optional(Type.Number({ description: "Number of results, 1-20 (default from settings, usually 5)" })),
  freshness: Type.Optional(
    Type.String({ description: "Time filter: pd (day), pw (week), pm (month), py (year), or YYYY-MM-DDtoYYYY-MM-DD" }),
  ),
  country: Type.Optional(Type.String({ description: "Two-letter country code for results, e.g. DE" })),
  offset: Type.Optional(Type.Number({ description: "Result offset for paging, 0-9" })),
  fetch_content: Type.Optional(
    Type.Boolean({ description: "Also fetch the top results and include their page content as Markdown" }),
  ),
  content_count: Type.Optional(Type.Number({ description: "How many results to fetch content for, 1-5 (default 3)" })),
  render: RenderEnum,
});

const FetchParams = Type.Object({
  url: Type.String({ description: "Absolute http(s) URL to fetch" }),
  render: RenderEnum,
  force: Type.Optional(Type.Boolean({ description: "Bypass the page cache and refetch" })),
  max_chars: Type.Optional(Type.Number({ description: "Maximum characters of Markdown to return" })),
  raw: Type.Optional(
    Type.Boolean({ description: "Return the page as plain text instead of Defuddle's extracted main content" }),
  ),
});

type ResultPage = Omit<Page, "via"> & { via: "http" | "browser" | "cache" };

interface SearchDetails {
  query: string;
  resultCount: number;
  urls: string[];
  withContent: number;
  moreResultsAvailable: boolean;
  truncated: boolean;
}

interface FetchDetails {
  url: string;
  finalUrl?: string;
  title?: string;
  via?: "http" | "browser" | "cache";
  words?: number;
  chars?: number;
  truncated?: boolean;
  relaxed?: boolean;
  cachePath?: string;
  stale?: boolean;
}

export default function webExtension(pi: ExtensionAPI): void {
  const { warning } = readSettings();

  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web with the Brave Search API. Returns titles, URLs, ages, and snippets; set fetch_content to also pull the top results as clean Markdown. Resolve relative or redirecting URLs with web_fetch before citing details.",
    promptSnippet: "Search the web with Brave Search",
    promptGuidelines: [
      "Use web_search for current information, documentation, and anything not in the repository.",
      "Snippets are truncated; fetch the page with web_fetch before relying on specifics.",
    ],
    parameters: SearchParams,
    annotations: { readOnlyHint: true, openWorldHint: true },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { settings } = readSettings();
      const count = clamp(params.count ?? settings.count, 1, 20);
      const search = await braveSearch(
        params.query,
        { count, country: params.country, freshness: params.freshness, offset: params.offset },
        settings,
      );
      if (search.results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No results for "${params.query}".` }],
          details: {
            query: params.query,
            resultCount: 0,
            urls: [],
            withContent: 0,
            moreResultsAvailable: false,
            truncated: false,
          } satisfies SearchDetails,
        };
      }

      const contentCount = params.fetch_content ? clamp(params.content_count ?? 3, 1, 5) : 0;
      const pages = contentCount
        ? await fetchContents(search.results.slice(0, contentCount), settings, params.render, ctx.signal)
        : new Map<string, ResultPage | Error>();

      let text = renderSearch(params.query, search.results, pages, settings);
      const capped = cap(text, settings.maxChars);
      text = capped.text;
      if (capped.truncated) {
        text += `\n\n[Output truncated: showing ${capped.shown} of ${capped.total} characters. Narrow the query, lower content_count, or fetch individual URLs with web_fetch.]`;
      }

      return {
        content: [{ type: "text" as const, text }],
        details: {
          query: params.query,
          resultCount: search.results.length,
          urls: search.results.map((result) => result.url),
          withContent: pages.size,
          moreResultsAvailable: search.moreResultsAvailable,
          truncated: capped.truncated,
        } satisfies SearchDetails,
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("web_search "))}${theme.fg("accent", `"${args.query}"`)}${theme.fg("dim", args.fetch_content ? " +content" : "")}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as SearchDetails | undefined;
      if (!details) return new Text(theme.fg("dim", "searching…"), 0, 0);
      let text = theme.fg("success", `${details.resultCount} results`);
      if (details.withContent) text += theme.fg("dim", ` · ${details.withContent} with content`);
      if (details.truncated) text += theme.fg("warning", " · truncated");
      if (expanded) {
        for (const url of details.urls.slice(0, 10)) text += `\n${theme.fg("dim", url)}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Fetch page",
    description:
      "Fetch a URL and extract its main content as Markdown with Defuddle. Reads blogs, docs, and articles without boilerplate, and renders JavaScript-heavy pages in a headless browser when the plain fetch comes back thin. Results are cached on disk; use force to refetch.",
    promptSnippet: "Fetch a URL and extract its content as Markdown",
    promptGuidelines: [
      "Prefer web_fetch over curl for reading pages: it strips navigation, ads, and boilerplate.",
      "If a page returns 403 or looks empty, retry with render: \"browser\".",
    ],
    parameters: FetchParams,
    annotations: { readOnlyHint: true, openWorldHint: true },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { settings } = readSettings();
      const url = normalizeUrl(params.url);
      const cachedEntry = params.force ? undefined : await readCache(url, settings);
      // An explicit browser render must not be served a plain-HTTP cache hit.
      const cached = params.render === "browser" && cachedEntry?.entry.via !== "browser" ? undefined : cachedEntry;
      if (cached && !cached.stale) {
        const page = { ...cached.entry, via: "cache" as const };
        return fetchResult(page, settings, cached.entry.fetchedAt, params.max_chars);
      }

      let page: Page;
      try {
        page = await fetchPage(url, { settings, render: params.render as RenderMode | undefined, raw: params.raw });
      } catch (error) {
        // A stale page beats no page: report it with the failure so the model
        // can judge whether the freshness matters.
        if (cached) {
          const reason = error instanceof Error ? error.message : String(error);
          const stalePage = { ...cached.entry, via: "cache" as const };
          return fetchResult(stalePage, settings, cached.entry.fetchedAt, params.max_chars, `Refetch failed (${reason}); serving the cached copy.`);
        }
        throw await withSignalHint(error, ctx.signal);
      }

      // A thin extraction is usually a render that did not settle; caching it
      // would pin the failure for the whole TTL.
      const cachePath =
        page.wordCount >= settings.minWords ? await writeCache({ ...page, fetchedAt: Date.now() }, settings) : undefined;
      return fetchResult(page, settings, Date.now(), params.max_chars, undefined, cachePath);
    },

    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("web_fetch "))}${theme.fg("accent", args.url)}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as FetchDetails | undefined;
      if (!details?.title) return new Text(theme.fg("dim", "fetching…"), 0, 0);
      let text = `${theme.fg("success", details.title)}${theme.fg("dim", ` · ${details.words ?? 0} words · ${details.via ?? "http"}`)}`;
      if (details.truncated) text += theme.fg("warning", " · truncated");
      if (details.stale) text += theme.fg("warning", " · stale cache");
      if (expanded) {
        const body = result.content[0];
        if (body?.type === "text") {
          const lines = body.text.split("\n").slice(0, 12);
          for (const line of lines) text += `\n${theme.fg("dim", line)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("web", {
    description: "Show web tool status or clear the page cache (/web clear)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const { settings } = readSettings();
      if (args.trim() === "clear" || args.trim() === "clear-cache") {
        const { files, bytes } = await clearCache(settings);
        ctx.ui.notify(`Cleared ${files} cached pages (${formatSize(bytes)})`, "info");
        return;
      }
      const lines = [
        `key: ${settings.braveApiKey ? "configured" : "missing"}`,
        `config: ${configPath()}`,
        `cache: ${settings.cacheDir} (${settings.cacheTtlMs ? `${Math.round(settings.cacheTtlMs / 3600000)}h TTL` : "disabled"})`,
        `render: ${settings.render} · browser: ${settings.browserChannels.join(" → ")} → chromium`,
        `country: ${settings.country} · results: ${settings.count} · output budget: ${settings.maxChars} chars`,
      ];
      ctx.ui.notify(lines.join("\n"), settings.braveApiKey ? "info" : "warning");
      if (args.trim() === "browser") {
        try {
          const rendered = await renderPage("https://example.com", settings);
          ctx.ui.notify(`Browser render OK via ${rendered.browser}`, "info");
        } catch (error) {
          ctx.ui.notify(`Browser render failed: ${(error as Error).message}`, "error");
        }
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (warning) ctx.ui.notify(warning, "warning");
  });

  pi.on("session_shutdown", async () => {
    await closeBrowser();
  });
}

async function fetchContents(
  results: SearchResult[],
  settings: WebSettings,
  render: string | undefined,
  signal: AbortSignal | undefined,
  concurrency = 3,
): Promise<Map<string, ResultPage | Error>> {
  const pages = new Map<string, ResultPage | Error>();
  const queue = [...results];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (signal?.aborted) return;
      const url = next.url;
      try {
        const cached = await readCache(url, settings);
        const page =
          cached && !cached.stale
            ? { ...cached.entry, via: "cache" as const }
            : await fetchPage(url, { settings, render: render as RenderMode | undefined }).then(async (fetched) => {
                if (fetched.wordCount >= settings.minWords) {
                  await writeCache({ ...fetched, fetchedAt: Date.now() }, settings);
                }
                return fetched;
              });
        pages.set(url, page);
      } catch (error) {
        pages.set(url, error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  await Promise.all(workers);
  return pages;
}

function renderSearch(
  query: string,
  results: SearchResult[],
  pages: Map<string, ResultPage | Error>,
  settings: WebSettings,
): string {
  const lines = [`Search: ${query} (${results.length} results)`];
  results.forEach((result, index) => {
    lines.push("", `${index + 1}. ${result.title || "(untitled)"}`, `   ${result.url}`);
    const meta = [result.site, result.age].filter(Boolean).join(" · ");
    if (meta) lines.push(`   ${meta}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
    const page = pages.get(result.url);
    if (page instanceof Error) {
      lines.push(`   Content: unavailable (${page.message})`);
    } else if (page) {
      const body = cap(page.markdown, settings.pageChars);
      lines.push(`   Content (${page.wordCount} words via ${page.via}):`, indent(body.text, "   "));
      if (body.truncated) lines.push(`   [page content truncated at ${settings.pageChars} chars; use web_fetch for the rest]`);
    }
  });
  return lines.join("\n");
}

function fetchResult(
  page: ResultPage,
  settings: WebSettings,
  fetchedAt: number,
  maxChars: number | undefined,
  note?: string,
  cachePath?: string,
): { content: { type: "text"; text: string }[]; details: FetchDetails } {
  const limit = clamp(maxChars ?? settings.maxChars, 500, settings.maxChars);
  const body = cap(page.markdown, limit);
  const header = [`# ${page.title}`, `URL: ${page.finalUrl || page.url}`];
  if (page.author) header.push(`Author: ${page.author}`);
  if (page.published) header.push(`Published: ${page.published}`);
  const flags = [page.relaxed ? "relaxed" : "", `via ${page.via}`].filter(Boolean).join(" · ");
  header.push(`Fetched: ${new Date(fetchedAt).toISOString()} · ${page.wordCount} words · ${flags}`);

  let text = `${header.join("\n")}\n\n${body.text}`;
  if (body.truncated) {
    text += `\n\n[Content truncated: showing ${body.shown} of ${body.total} characters.`;
    if (cachePath) text += ` Full text: ${cachePath} (JSON with a "markdown" field).`;
    text += "]";
  }
  if (page.relaxed) {
    text += `\n\n[Relaxed extraction: Defuddle's main-content heuristics found little, so this includes navigation or listing boilerplate.]`;
  }
  if (page.wordCount < settings.minWords) {
    text += `\n\n[Short extraction (${page.wordCount} words): the page may be image-heavy or load its content on interaction. Try raw: true, or render: "browser".]`;
  }
  if (note) text += `\n\n[${note}]`;

  return {
    content: [{ type: "text", text }],
    details: {
      url: page.url,
      finalUrl: page.finalUrl,
      title: page.title,
      via: page.via,
      words: page.wordCount,
      chars: page.markdown.length,
      truncated: body.truncated,
      relaxed: page.relaxed,
      cachePath,
      stale: page.via === "cache",
    },
  };
}

function cap(text: string, limit: number): { text: string; truncated: boolean; shown: number; total: number } {
  if (text.length <= limit) return { text, truncated: false, shown: text.length, total: text.length };
  return { text: text.slice(0, limit), truncated: true, shown: limit, total: text.length };
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `${prefix}${line}` : line))
    .join("\n");
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new FetchError(`Not a valid URL: ${input}`, "Pass an absolute URL, e.g. https://example.com/article");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchError(`Unsupported protocol ${url.protocol}`, "Only http and https URLs are fetched.");
  }
  return url.toString();
}

async function withSignalHint(error: unknown, signal: AbortSignal | undefined): Promise<Error> {
  if (signal?.aborted && error instanceof FetchError) {
    return new FetchError(`${error.message} (cancelled)`, error.hint);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function clamp(value: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

