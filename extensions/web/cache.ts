import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "./extract.ts";
import type { WebSettings } from "./settings.ts";

export interface CacheEntry extends Page {
  fetchedAt: number;
}

export function cacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export function cachePath(url: string, settings: WebSettings): string {
  return join(settings.cacheDir, `${cacheKey(url)}.json`);
}

/** Returns the cached page, including a stale one so a failed refetch can fall back. */
export async function readCache(
  url: string,
  settings: WebSettings,
): Promise<{ entry: CacheEntry; stale: boolean } | undefined> {
  if (!settings.cacheTtlMs) return undefined;
  try {
    const raw = await readFile(cachePath(url, settings), "utf8");
    const entry = JSON.parse(raw) as CacheEntry;
    // Thin extractions are never written, and junk ones from older runs must not
    // pin an empty page for the whole TTL.
    if (typeof entry?.markdown !== "string" || entry.markdown.length < 20) return undefined;
    if (typeof entry.wordCount === "number" && entry.wordCount < settings.minWords) return undefined;
    const age = Date.now() - entry.fetchedAt;
    return { entry, stale: !(age >= 0 && age < settings.cacheTtlMs) };
  } catch {
    return undefined;
  }
}

export async function writeCache(entry: CacheEntry, settings: WebSettings): Promise<string | undefined> {
  try {
    await mkdir(settings.cacheDir, { recursive: true });
    const path = cachePath(entry.url, settings);
    await writeFile(path, JSON.stringify(entry), "utf8");
    return path;
  } catch {
    return undefined;
  }
}

export async function clearCache(settings: WebSettings): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  try {
    for (const name of await readdir(settings.cacheDir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(settings.cacheDir, name);
      const raw = await readFile(path, "utf8").catch(() => undefined);
      if (raw === undefined) continue;
      bytes += raw.length;
      files += 1;
      await rm(path, { force: true });
    }
  } catch {
    // Missing cache directory is an empty cache.
  }
  return { files, bytes };
}
