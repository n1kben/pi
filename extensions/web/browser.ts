import { existsSync } from "node:fs";
import type { Browser } from "playwright-core";
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

/** Render a page in a real browser and return the DOM after scripts settle. */
export async function renderPage(url: string, settings: WebSettings): Promise<RenderedPage> {
  const { browser, label } = await getBrowser(settings);
  const context = await browser.newContext({
    userAgent: settings.userAgent,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    ignoreHTTPSErrors: true,
  });
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
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (response && !response.ok() && response.status() >= 400) {
      throw new Error(`HTTP ${response.status()} ${response.statusText()}`);
    }
    // Single-page docs keep hydrating after DOMContentLoaded; the short idle
    // wait catches most of it without stalling on pages that never settle.
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    return { html: await page.content(), finalUrl: page.url(), browser: label };
  } finally {
    await context.close().catch(() => undefined);
  }
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
