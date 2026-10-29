import { FetchError } from "./extract.ts";
import type { WebSettings } from "./settings.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  age?: string;
  site?: string;
}

export interface SearchOptions {
  count: number;
  country?: string;
  freshness?: string;
  offset?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  moreResultsAvailable: boolean;
}

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  page_age?: string;
  profile?: { name?: string };
  meta_url?: { hostname?: string };
  extra_snippets?: string[];
}

interface BraveResponse {
  web?: { results?: BraveResult[] };
  query?: { more_results_available?: boolean };
}

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export async function braveSearch(
  query: string,
  options: SearchOptions,
  settings: WebSettings,
): Promise<SearchResponse> {
  const apiKey = settings.braveApiKey;
  if (!apiKey) {
    throw new FetchError(
      "Brave Search has no API key",
      `Add "braveApiKey" to ${process.env.PI_WEB_CONFIG ?? "~/.pi/agent/web.json"} or export BRAVE_API_KEY.`,
    );
  }

  const params = new URLSearchParams({
    q: query,
    count: String(options.count),
    country: (options.country ?? settings.country).toUpperCase(),
    result_filter: "web",
    text_decorations: "false",
    extra_snippets: "true",
  });
  const freshness = options.freshness ?? settings.freshness;
  if (freshness) params.set("freshness", freshness);
  if (options.offset) params.set("offset", String(options.offset));

  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch (error) {
    throw new FetchError(`Brave Search request failed: ${(error as Error).message}`);
  }

  if (!response.ok) throw braveError(response);

  const data = (await response.json()) as BraveResponse;
  const results = (data.web?.results ?? []).slice(0, options.count).map((result) => ({
    title: (result.title ?? "").trim(),
    url: result.url ?? "",
    snippet: joinSnippets(result),
    age: result.age ?? result.page_age ?? undefined,
    site: result.profile?.name ?? result.meta_url?.hostname ?? undefined,
  }));
  return { results: results.filter((result) => result.url), moreResultsAvailable: Boolean(data.query?.more_results_available) };
}

function joinSnippets(result: BraveResult): string {
  const parts = [result.description ?? "", ...(result.extra_snippets ?? [])].map((part) => part.trim()).filter(Boolean);
  return parts.join(" ").replace(/\s+/g, " ");
}

function braveError(response: Response): FetchError {
  const status = response.status;
  if (status === 401) {
    return new FetchError("Brave rejected the API key (HTTP 401)", "Check braveApiKey in ~/.pi/agent/web.json.");
  }
  if (status === 402) {
    return new FetchError("Brave subscription does not cover this endpoint (HTTP 402)", "Check the plan on the Brave dashboard.");
  }
  if (status === 429) {
    return new FetchError("Brave rate limit hit (HTTP 429)", "The free plan allows about one request per second; retry shortly.");
  }
  return new FetchError(`Brave Search failed: HTTP ${status} ${response.statusText}`);
}
