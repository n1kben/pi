import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type Exec = ExtensionAPI["exec"];

const WIDGET_ID = "links";
const MAX_LINKS_PER_GROUP = 8;
const WIDGET_GROUPS = ["Issues", "PRs"] as const;

type WidgetGroup = (typeof WIDGET_GROUPS)[number];

type Link = {
  key: string;
  group: WidgetGroup;
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

function linkableEntryText(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const record = entry as Record<string, unknown>;
  if (record.type !== "message" || !record.message || typeof record.message !== "object") return "";

  const message = record.message as Record<string, unknown>;
  return shouldScanMessage(message) ? textContent(message.content) : "";
}

/**
 * Branch text cached across the streaming updates that drive the widget.
 * Entries are append-only within a branch, so only new entries are scanned;
 * a different leaf (tree navigation, fork) rebuilds from scratch.
 */
let branchCache: { leafId: string | null; count: number; text: string } | undefined;

function branchText(ctx: ExtensionContext): string {
  const leafId = ctx.sessionManager.getLeafId();
  const entries = ctx.sessionManager.getBranch();

  if (!branchCache || branchCache.leafId !== leafId || entries.length < branchCache.count) {
    const text = entries.map(linkableEntryText).filter(Boolean).join("\n");
    branchCache = { leafId, count: entries.length, text };
    return text;
  }

  if (entries.length > branchCache.count) {
    const fresh = entries.slice(branchCache.count).map(linkableEntryText).filter(Boolean).join("\n");
    if (fresh) branchCache.text = branchCache.text ? `${branchCache.text}\n${fresh}` : fresh;
    branchCache.count = entries.length;
  }

  return branchCache.text;
}

function normalizeRepo(owner: string, repo: string): string {
  return `${owner}/${repo.replace(/\.git$/i, "")}`.toLowerCase();
}

/**
 * The GitHub repo this checkout belongs to, or null when it has none.
 *
 * The host may carry an SSH alias (`git@github.com-work:owner/repo.git`, the usual
 * second-account setup), so whatever follows `github.com` is still the same host.
 */
async function currentGitHubRepo(exec: Exec, cwd: string): Promise<string | null> {
  try {
    const { stdout, code } = await exec("git", ["config", "--get", "remote.origin.url"], { cwd, timeout: 5000 });
    if (code !== 0) return null;
    const match = stdout.trim().match(/github\.com[^/]*[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
    return match ? normalizeRepo(match[1]!, match[2]!) : null;
  } catch {
    return null;
  }
}

function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?\])}>"'`]+$/g, "");
}

function isTemplateUrl(url: string): boolean {
  const value = url.toLowerCase();
  return value.includes("%7b") || value.includes("%7d") || value.includes("${");
}

function* urlsIn(text: string, hostname: string): Generator<URL> {
  for (const match of text.matchAll(/https?:\/\/[^\s<>()]+/gi)) {
    const rawUrl = trimUrl(match[0]!);
    if (isTemplateUrl(rawUrl)) continue;

    try {
      const url = new URL(rawUrl);
      if (url.hostname !== hostname) continue;
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

export default function (pi: ExtensionAPI) {
  const exec: Exec = (command, args, options) => pi.exec(command, args, options);
  /** Resolved once per session; undefined while unknown, null when the checkout has no GitHub remote. */
  let currentRepo: string | null = null;

  function chatTextForContext(ctx: ExtensionContext, extraText = ""): string {
    return `${branchText(ctx)}\n${extraText}`;
  }

  function update(ctx: ExtensionContext, extraText = "") {
    if (!ctx.hasUI) return;

    const links = collectWidgetLinks(chatTextForContext(ctx, extraText), currentRepo ?? undefined);
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

  pi.on("session_start", async (_event, ctx) => {
    currentRepo = await currentGitHubRepo(exec, ctx.cwd);
    update(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    const message = event.message as unknown as Record<string, unknown>;
    update(ctx, shouldScanMessage(message) ? textContent(message.content) : "");
  });

  pi.on("message_end", (_event, ctx) => update(ctx));
}
