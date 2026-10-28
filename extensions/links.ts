import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFileSync } from "node:child_process";

const WIDGET_ID = "links";
const MAX_LINKS_PER_GROUP = 8;
const WIDGET_GROUPS = ["Issues", "PRs"] as const;

type WidgetGroup = (typeof WIDGET_GROUPS)[number];
type LinkGroup = WidgetGroup | "URL";

type Link = {
  key: string;
  group: LinkGroup;
  label: string;
  url: string;
};

function osc8(label: string, url: string): string {
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const block = part as Record<string, unknown>;
    return typeof block.text === "string" ? block.text : "";
  }).filter(Boolean).join("\n");
}

function shouldScanMessage(message: Record<string, unknown>): boolean {
  return message.role === "user" || message.role === "assistant";
}

function branchText(ctx: ExtensionContext): string {
  return ctx.sessionManager.getBranch().map((entry: unknown) => {
    if (!entry || typeof entry !== "object") return "";
    const record = entry as Record<string, unknown>;
    if (record.type !== "message" || !record.message || typeof record.message !== "object") return "";

    const message = record.message as Record<string, unknown>;
    return shouldScanMessage(message) ? textContent(message.content) : "";
  }).filter(Boolean).join("\n");
}

function normalizeRepo(owner: string, repo: string): string {
  return `${owner}/${repo.replace(/\.git$/i, "")}`.toLowerCase();
}

function currentGitHubRepo(cwd: string): string | undefined {
  try {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
    return match ? normalizeRepo(match[1]!, match[2]!) : undefined;
  } catch {
    return undefined;
  }
}

function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?\])}>"'`]+$/g, "");
}

function isTemplateUrl(url: string): boolean {
  const value = url.toLowerCase();
  return value.includes("%7b") || value.includes("%7d") || value.includes("${");
}

function* urlsIn(text: string, hostname?: string): Generator<URL> {
  for (const match of text.matchAll(/https?:\/\/[^\s<>()]+/gi)) {
    const rawUrl = trimUrl(match[0]!);
    if (isTemplateUrl(rawUrl)) continue;

    try {
      const url = new URL(rawUrl);
      if (hostname && url.hostname !== hostname) continue;
      yield url;
    } catch {
      // Ignore malformed URLs from streamed/generated text.
    }
  }
}

function githubLabel(repo: string, issue: string, currentRepo: string | undefined): string {
  return repo === currentRepo ? `#${issue}` : `${repo}#${issue}`;
}

function collectGitHubLinks(text: string, currentRepo: string | undefined): Link[] {
  const links = new Map<string, Link>();

  for (const url of urlsIn(text, "github.com")) {
    const [owner, repoPart, kind, id] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repoPart || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+(?:\.git)?$/.test(repoPart)) continue;
    if ((kind !== "issues" && kind !== "pull") || !/^\d+$/.test(id ?? "")) continue;

    const repo = normalizeRepo(owner, repoPart);
    const group: WidgetGroup = kind === "pull" ? "PRs" : "Issues";
    const key = `${repo}/${kind}/${id}`;
    links.set(key, { key, group, label: githubLabel(repo, id!, currentRepo), url: url.toString() });
  }

  return [...links.values()];
}

function collectLinearLinks(text: string): Link[] {
  const links = new Map<string, Link>();

  for (const url of urlsIn(text, "linear.app")) {
    const [, issue, key] = url.pathname.split("/").filter(Boolean);
    if (issue !== "issue" || !key || !/^[A-Z]{2,10}-\d+$/i.test(key)) continue;

    const canonicalKey = key.toUpperCase();
    links.set(canonicalKey, { key: canonicalKey, group: "Issues", label: canonicalKey, url: url.toString() });
  }

  return [...links.values()];
}

function collectWidgetLinks(text: string, currentRepo: string | undefined): Link[] {
  return [...collectGitHubLinks(text, currentRepo), ...collectLinearLinks(text)];
}

function genericUrlLabel(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.hostname}${path}`;
}

function collectAllLinks(text: string, currentRepo: string | undefined): Link[] {
  const links = new Map<string, Link>();

  for (const link of collectWidgetLinks(text, currentRepo)) {
    links.set(link.url, link);
  }

  for (const url of urlsIn(text)) {
    const normalized = url.toString();
    if (links.has(normalized)) continue;
    links.set(normalized, {
      key: normalized,
      group: "URL",
      label: genericUrlLabel(url),
      url: normalized,
    });
  }

  return [...links.values()];
}

function renderGroup(
  group: WidgetGroup,
  links: Link[],
  theme: ExtensionContext["ui"]["theme"],
  width: number,
): string | undefined {
  const groupLinks = links
    .filter((link) => link.group === group)
    .slice(-MAX_LINKS_PER_GROUP)
    .sort((a, b) => {
      if (group !== "Issues") return 0;
      const aLinear = a.url.includes("linear.app/");
      const bLinear = b.url.includes("linear.app/");
      return Number(bLinear) - Number(aLinear);
    });

  if (groupLinks.length === 0 || width <= 0) return undefined;

  const prefix = `${group}: `;
  if (width <= prefix.length) return theme.fg("muted", prefix.slice(0, Math.max(0, width)));

  const overflow = theme.fg("dim", " …");
  let visible = prefix.length;
  let line = theme.fg("muted", prefix);

  for (const [index, link] of groupLinks.entries()) {
    const separator = index === 0 ? "" : ", ";
    const nextWidth = separator.length + link.label.length;
    if (visible + nextWidth > width) {
      line += overflow;
      break;
    }

    line += separator + osc8(theme.fg("mdLink", link.label), link.url);
    visible += nextWidth;
  }

  return line;
}

function renderLinks(links: Link[], theme: ExtensionContext["ui"]["theme"], width: number): string[] {
  return WIDGET_GROUPS
    .map((group) => renderGroup(group, links, theme, width))
    .filter((line): line is string => typeof line === "string");
}

function openUrl(url: string): void {
  if (process.platform === "darwin") {
    execFileSync("open", [url], { stdio: "ignore" });
    return;
  }
  if (process.platform === "win32") {
    execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    return;
  }
  execFileSync("xdg-open", [url], { stdio: "ignore" });
}

export default function (pi: ExtensionAPI) {
  let currentRepo: string | undefined;

  function chatTextForContext(ctx: ExtensionContext, extraText = ""): string {
    return `${branchText(ctx)}\n${extraText}`;
  }

  function getCurrentRepo(ctx: ExtensionContext): string | undefined {
    currentRepo ??= currentGitHubRepo(ctx.cwd);
    return currentRepo;
  }

  function update(ctx: ExtensionContext, extraText = "") {
    if (!ctx.hasUI) return;

    const links = collectWidgetLinks(chatTextForContext(ctx, extraText), getCurrentRepo(ctx));
    if (links.length === 0) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }

    ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => ({
      invalidate() {},
      render(width: number) {
        return renderLinks(links, theme, width);
      },
    }), { placement: "aboveEditor" });
  }

  pi.on("session_start", (_event, ctx) => {
    currentRepo = currentGitHubRepo(ctx.cwd);
    update(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    const message = event.message as unknown as Record<string, unknown>;
    update(ctx, shouldScanMessage(message) ? textContent(message.content) : "");
  });

  pi.on("message_end", (_event, ctx) => update(ctx));

  pi.registerCommand("links", {
    description: "Select a detected link and open it in the browser",
    handler: async (_args, ctx) => {
      const links = collectAllLinks(chatTextForContext(ctx), getCurrentRepo(ctx));
      if (links.length === 0) {
        ctx.ui.notify("No links found", "info");
        return;
      }

      const counts = new Map<string, number>();
      for (const link of links) counts.set(link.label, (counts.get(link.label) ?? 0) + 1);

      const labels = links.map((link) => {
        const label = (counts.get(link.label) ?? 0) > 1 ? `${link.group}: ${link.label}` : link.label;
        return `${label}  ${link.url}`;
      });

      const choice = await ctx.ui.select("Open link", labels);
      if (!choice) return;

      const link = links[labels.indexOf(choice)];
      if (!link) return;

      try {
        openUrl(link.url);
      } catch (error) {
        ctx.ui.notify(`Could not open link: ${(error as Error).message}`, "error");
      }
    },
  });
}
