import { existsSync } from "node:fs";
import type { Browser, Page } from "playwright-core";
import type { WebSettings } from "./settings.ts";

export interface RenderedPage {
  html: string;
  finalUrl: string;
  browser: string;
}

type BrowserSession = { browser: Browser; label: string };

let sessionPromise: Promise<BrowserSession> | undefined;

/**
 * One browser per extension runtime: launching costs a second, and pi reloads
 * replace the runtime on `/reload`, so the old browser is closed on shutdown.
 */
export async function getBrowser(settings: WebSettings): Promise<BrowserSession> {
  if (sessionPromise) {
    const session = await sessionPromise.catch(() => undefined);
    if (session?.browser.isConnected()) return session;
    sessionPromise = undefined;
  }
  const launching = launch(settings);
  sessionPromise = launching;
  launching.catch(() => {
    if (sessionPromise === launching) sessionPromise = undefined;
  });
  return launching;
}

async function launch(settings: WebSettings): Promise<BrowserSession> {
  const { chromium } = await import("playwright-core");
  const attempts: { label: string; launch: { channel?: string; executablePath?: string } }[] = [];
  for (const channel of settings.browserChannels) {
    attempts.push({ label: channel, launch: { channel } });
  }
  const bundled = chromium.executablePath();
  if (existsSync(bundled)) attempts.push({ label: "chromium", launch: { executablePath: bundled } });

  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch({ ...attempt.launch, headless: !settings.headed });
      return { browser, label: attempt.label };
    } catch (error) {
      failures.push(`${attempt.label}: ${firstLine(error)}`);
    }
  }
  throw new Error(
    `No browser available for rendering. ${failures.length ? failures.join("; ") : "No candidates found"}. ` +
      "Install chromium with: cd ~/.pi/agent/extensions/web && npx playwright-core install chromium",
  );
}

/** Render a page in a real browser and return the DOM after its content settles. */
export async function renderPage(url: string, settings: WebSettings, signal?: AbortSignal): Promise<RenderedPage> {
  signal?.throwIfAborted();
  const { browser, label } = await getBrowser(settings);
  const context = await browser.newContext({
    userAgent: settings.userAgent,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    ignoreHTTPSErrors: true,
  });
  // Closing the context is the only way to interrupt an in-flight navigation.
  const abort = () => void context.close().catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(settings.browserTimeoutMs);
    // Images, media, and fonts never reach the extractor; skipping them makes
    // a render cheap on a small VPS.
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") return route.abort();
      return route.continue();
    });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", signal });
    if (response && !response.ok() && response.status() >= 400) {
      throw new Error(`HTTP ${response.status()} ${response.statusText()}`);
    }
    await settle(page, Math.min(SETTLE_MAX_MS, settings.browserTimeoutMs), signal);
    return { html: await page.content(), finalUrl: page.url(), browser: label };
  } catch (error) {
    if (signal?.aborted) throw new Error(`Browser render cancelled for ${url}`);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    await context.close().catch(() => undefined);
  }
}

const SETTLE_POLL_MS = 250;
/** How long a page with real content must stay unchanged before the render counts as settled. */
const SETTLE_HOLD_MS = 1000;
/** A page still showing placeholder text gets longer: it has not painted its content yet. */
const SHELL_HOLD_MS = 3000;
/** Below this many characters the page is probably still a shell, not an article. */
const SHELL_TEXT_CHARS = 200;
/** Hard cap on the settle wait, so pages that stream forever still return something. */
const SETTLE_MAX_MS = 10000;

interface Sample {
  /** Text length plus the tail, so appended content and spinners both register. */
  signature: string;
  textLength: number;
}

/**
 * Wait until the page's text stops changing.
 *
 * `networkidle` is a poor readiness signal in both directions: it fires before
 * hydration has painted anything, and it never fires on pages that poll or
 * stream. Watching the content itself is what Defuddle actually needs, and a
 * page with almost no text is given extra time so it can be replaced.
 */
async function settle(page: Page, budgetMs: number, signal?: AbortSignal): Promise<void> {
  const started = Date.now();
  let sample: Sample | undefined;
  let unchangedSince = started;
  for (;;) {
    signal?.throwIfAborted();
    // A navigation in flight destroys the execution context; sample again later.
    const next = await sampleText(page).catch(() => undefined);
    const now = Date.now();
    if (next && next.signature !== sample?.signature) {
      sample = next;
      unchangedSince = now;
    } else if (next) {
      const hold = next.textLength >= SHELL_TEXT_CHARS ? SETTLE_HOLD_MS : SHELL_HOLD_MS;
      if (now - unchangedSince >= hold) return;
    }
    if (now - started >= budgetMs) return;
    await delay(SETTLE_POLL_MS, signal);
  }
}

function sampleText(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
    return { signature: `${text.length}\u0000${text.slice(-120)}`, textLength: text.length };
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function closeBrowser(): Promise<void> {
  const session = await sessionPromise?.catch(() => undefined);
  sessionPromise = undefined;
  await session?.browser.close().catch(() => undefined);
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] ?? text;
}
