import { Defuddle, type DefuddleResponse } from "defuddle/node";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { renderPage } from "./browser.ts";
import type { RenderMode, WebSettings } from "./settings.ts";

export interface Page {
  url: string;
  finalUrl: string;
  title: string;
  markdown: string;
  author?: string;
  published?: string;
  site?: string;
  description?: string;
  wordCount: number;
  via: "http" | "browser";
  /** Set when the relaxed pass was used, so the result includes some boilerplate. */
  relaxed?: boolean;
}

export interface FetchPageOptions {
  settings: WebSettings;
  render?: RenderMode;
  /** Render the page as plain fetched text instead of extracted markdown. */
  raw?: boolean;
  /** Pi's tool cancellation signal, propagated into the fetch and the browser render. */
  signal?: AbortSignal;
}

/** A failure the model can act on, with a suggestion for the next attempt. */
export class FetchError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "FetchError";
    this.hint = hint;
  }
}

const HTML_TYPES = ["text/html", "application/xhtml+xml", "application/xml", "text/xml"];
const TEXT_TYPES = ["text/plain", "text/markdown", "application/json", "text/csv", "text/yaml", "application/yaml"];

/** Responses above this are not prose, and they would sit in memory and in the cache. */
const MAX_BYTES = 8 * 1024 * 1024;

export async function fetchPage(url: string, options: FetchPageOptions): Promise<Page> {
  const { settings, signal } = options;
  const mode = options.render ?? settings.render;

  if (mode === "browser") {
    const rendered = await renderPage(url, settings, signal);
    if (options.raw) return rawTextPage(url, rendered.html, rendered.finalUrl, "browser");
    return extract(rendered.html, rendered.finalUrl, "browser", settings);
  }

  let http: HttpResult;
  try {
    http = await fetchOverHttp(url, settings, signal);
  } catch (error) {
    // A bot wall on the plain fetch usually lifts in a real browser, but a
    // cancelled fetch is not a failure to work around.
    if (mode === "http" || signal?.aborted || !isBotWall(error)) throw error;
    const rendered = await renderPage(url, settings, signal).catch(() => undefined);
    if (!rendered) throw error;
    if (options.raw) return rawTextPage(url, rendered.html, rendered.finalUrl, "browser");
    return extract(rendered.html, rendered.finalUrl, "browser", settings);
  }
  if (http.kind === "text") return textPage(url, http.body, http.finalUrl);
  if (options.raw) return rawTextPage(url, http.html, http.finalUrl, "http");

  let page = await extract(http.html, http.finalUrl, "http", settings);
  if (mode === "http") return page;

  const thin = isThinPage(page, settings);
  if (thin || http.blocked) {
    const rendered = await renderPage(url, settings, signal).catch((error) => {
      if (signal?.aborted) throw error;
      return undefined;
    });
    if (rendered) {
      const fromBrowser = await extract(rendered.html, rendered.finalUrl, "browser", settings);
      // A browser render that extracts less than the plain fetch is usually a
      // cookie wall or a client-rendered 404; keep the better of the two.
      if (fromBrowser.wordCount >= page.wordCount) page = fromBrowser;
    }
  }
  if (page.markdown.length < 20) {
    throw new FetchError(
      `No readable content extracted from ${url}`,
      "The page may require sign-in or render only media. Try raw: true, or render: \"browser\".",
    );
  }
  return page;
}

type HttpResult =
  | { kind: "html"; html: string; finalUrl: string; blocked: boolean }
  | { kind: "text"; body: string; finalUrl: string };

async function fetchOverHttp(url: string, settings: WebSettings, signal?: AbortSignal): Promise<HttpResult> {
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        "User-Agent": settings.userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (error) {
    if (signal?.aborted) throw fetchCancelled(url);
    const name = (error as Error).name;
    if (name === "AbortError" || name === "TimeoutError") {
      throw new FetchError(`Timed out after ${settings.timeoutMs}ms fetching ${url}`, "Retry, or use render: \"browser\".");
    }
    throw new FetchError(`Could not reach ${url}: ${(error as Error).message}`);
  }

  if (!response.ok) throw httpError(response, url);

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (TEXT_TYPES.some((type) => contentType.includes(type))) {
    return { kind: "text", body: await readBody(response, url, settings, signal), finalUrl: response.url || url };
  }
  if (contentType && !HTML_TYPES.some((type) => contentType.includes(type))) {
    throw new FetchError(
      `Unsupported content type "${contentType.split(";")[0]}" at ${url}`,
      "Only HTML, XML, and plain text pages are extracted. Fetch binaries with bash instead.",
    );
  }
  const html = await readBody(response, url, settings, signal);
  // A 200 with almost no markup is a JS shell or a bot wall; the caller escalates.
  return { kind: "html", html, finalUrl: response.url || url, blocked: html.length < 2000 };
}

/**
 * Read the body with a byte ceiling: `response.text()` on a multi-gigabyte URL
 * buffers the whole thing, and the cache would keep it.
 */
async function readBody(
  response: Response,
  url: string,
  settings: WebSettings,
  signal?: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw tooLarge(url, declared);

  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(url, total);
      }
      chunks.push(value);
    }
  } catch (error) {
    // The timeout fires while the body is streaming, so the abort surfaces here.
    if (signal?.aborted) throw fetchCancelled(url);
    if (error instanceof FetchError) throw error;
    const name = (error as Error).name;
    if (name === "AbortError" || name === "TimeoutError") {
      throw new FetchError(`Timed out after ${settings.timeoutMs}ms fetching ${url}`, "Retry, or use render: \"browser\".");
    }
    throw new FetchError(`Could not read ${url}: ${(error as Error).message}`);
  }
  if (signal?.aborted) throw fetchCancelled(url);
  return Buffer.concat(chunks).toString("utf8");
}

function tooLarge(url: string, bytes: number): FetchError {
  return new FetchError(
    `Response from ${url} is ${(bytes / 1024 / 1024).toFixed(1)}MB, over the ${MAX_BYTES / 1024 / 1024}MB limit`,
    "Large responses are not extracted. Download the file with bash instead.",
  );
}

function fetchCancelled(url: string): FetchError {
  return new FetchError(`Fetch cancelled for ${url}`);
}

function httpError(response: Response, url: string): FetchError {
  const status = response.status;
  if (status === 404) return new FetchError(`HTTP 404 at ${url}`, "Check the URL; the page may have moved.");
  if (status === 401 || status === 403) {
    return new FetchError(
      `HTTP ${status} at ${url}`,
      "The site is blocking plain HTTP requests. Retry with render: \"browser\".",
    );
  }
  if (status === 429) return new FetchError(`HTTP 429 (rate limited) at ${url}`, "Wait and retry.");
  return new FetchError(`HTTP ${status} ${response.statusText} at ${url}`);
}

/** Defuddle flags that keep card grids and listings that the defaults drop as boilerplate. */
const RELAXED = {
  removeContentPatterns: false,
  removeLowScoring: false,
  removeExactSelectors: false,
  removePartialSelectors: false,
} as const;

async function extract(html: string, url: string, via: Page["via"], settings: WebSettings): Promise<Page> {
  const first = await runDefuddle(html, url, via, {});
  // Only near-empty extractions earn a relaxed pass: it recovers listing pages
  // that look like boilerplate, but it also drags in navigation on pages that
  // already extracted fine.
  if (first.wordCount >= 25 && first.markdown.length >= 120) return first;

  const relaxed = await runDefuddle(html, url, via, RELAXED);
  if (relaxed.wordCount < 25 || relaxed.markdown.length < 120) return first;
  if (!isThinPage(first, settings) || relaxed.wordCount <= first.wordCount) return first;
  return { ...relaxed, relaxed: true };
}

async function runDefuddle(
  html: string,
  url: string,
  via: Page["via"],
  options: Record<string, unknown>,
): Promise<Page> {
  const { document } = parseHTML(html);
  const result: DefuddleResponse = await Defuddle(
    document as unknown as Parameters<typeof Defuddle>[0],
    url,
    { markdown: true, useAsync: true, ...options },
  );
  // Defuddle's own Markdown conversion returns an empty string for some pages.
  // Its `content` is usually cleaned HTML, but for some pages it is already
  // Markdown, so sniff before converting.
  const raw = result.contentMarkdown || result.content || "";
  const markdown = cleanMarkdown(result.contentMarkdown || isAlreadyMarkdown(raw) || !looksLikeHtml(raw) ? raw : htmlToMarkdown(raw));
  const fallbackTitle = document.querySelector("title")?.textContent?.trim() ?? "";
  return {
    url,
    finalUrl: url,
    title: (result.title || fallbackTitle || new URL(url).hostname).trim(),
    markdown,
    author: emptyToUndefined(result.author),
    published: emptyToUndefined(result.published),
    site: emptyToUndefined(result.site ?? result.domain),
    description: emptyToUndefined(result.description),
    wordCount: countWords(markdown) || result.wordCount,
    via,
  };
}

/** Some Defuddle responses are Markdown already; converting those escapes every heading and fence. */
function isAlreadyMarkdown(content: string): boolean {
  if (!/^#{1,6} /m.test(content) && !content.includes("```")) return false;
  const tags = (content.match(/<[a-z][^>]*>/gi) ?? []).length;
  return tags < Math.max(5, content.length / 500);
}

function looksLikeHtml(content: string): boolean {
  return /<(?:p|div|section|article|main|h[1-6]|li|a|span|table|pre|code|img)\b[^>]*>/i.test(content);
}

let turndown: TurndownService | undefined;

function htmlToMarkdown(html: string | undefined): string {
  if (!html) return "";
  if (!turndown) {
    turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
    turndown.use(gfm);
    // Bare links ("[free valuation](https://…)") keep their text; empty ones add noise.
    turndown.addRule("dropEmptyLinks", {
      filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
      replacement: () => "",
    });
  }
  return turndown.turndown(html);
}

function isThinPage(page: Page, settings: WebSettings): boolean {
  return page.wordCount < settings.minWords || page.markdown.length < 400;
}

/** Skip Defuddle: hand back the document text so the caller can judge the raw page. */
function rawTextPage(url: string, html: string, finalUrl: string, via: Page["via"]): Page {
  const { document } = parseHTML(html);
  for (const element of document.querySelectorAll("script, style, noscript, template")) element.remove();
  const title = document.querySelector("title")?.textContent?.trim() || new URL(finalUrl).hostname;
  const body = (document.body?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return { url, finalUrl, title, markdown: body, wordCount: countWords(body), via };
}

/** Inline base64 images are noise that eats the output budget. */
function cleanMarkdown(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\(data:[^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\(\)/g, "")
    .replace(/\\([[\]])/g, "$1")
    .replace(/(\]\([^)]*)\\([_*])/g, "$1$2")
    .replace(/[A-Za-z0-9+/]{200,}={0,2}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textPage(url: string, body: string, finalUrl: string): Page {
  return {
    url,
    finalUrl,
    title: finalUrl,
    markdown: body.trim(),
    wordCount: countWords(body),
    via: "http",
  };
}

function isBotWall(error: unknown): boolean {
  return error instanceof FetchError && /^HTTP (401|403|429)\b/.test(error.message);
}

function countWords(text: string): number {
  const words = text.trim().match(/\S+/g);
  return words ? words.length : 0;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
