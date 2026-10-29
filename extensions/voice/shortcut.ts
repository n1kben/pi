import { execFileSync } from "node:child_process";

/** The shortcut new users get when nothing on the system claims it. */
export const PREFERRED_SHORTCUT = "ctrl+space";
/** Used instead when Ctrl+Space would switch keyboard input sources. */
export const FALLBACK_SHORTCUT = "ctrl+alt+z";

const MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"] as const;
const SPECIAL_KEYS = new Set([
  "escape",
  "enter",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
]);
const SYMBOL_KEYS = new Set(["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/"]);

/** Canonical form of a shortcut, or undefined when it would not be bindable. */
export function normalizeShortcut(input: string): string | undefined {
  const parts = input
    .trim()
    .toLowerCase()
    .replaceAll("option", "alt")
    .replaceAll("command", "super")
    .replaceAll("cmd", "super")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;

  const key = parts.at(-1)!;
  const modifiers = parts.slice(0, -1);
  if (new Set(modifiers).size !== modifiers.length) return undefined;
  if (modifiers.some((m) => !MODIFIER_ORDER.includes(m as (typeof MODIFIER_ORDER)[number]))) {
    return undefined;
  }

  const isLetter = /^[a-z]$/.test(key);
  const isDigit = /^\d$/.test(key);
  const isFunction = /^f(?:[1-9]|1[0-2])$/.test(key);
  const isSpecial = SPECIAL_KEYS.has(key);
  const isSymbol = SYMBOL_KEYS.has(key);
  if (!isLetter && !isDigit && !isFunction && !isSpecial && !isSymbol) return undefined;

  // Bare printable keys would make normal editor input impossible.
  if (modifiers.length === 0 && !isFunction) return undefined;
  // Shift-only printable keys are also normal text input.
  if (modifiers.length === 1 && modifiers[0] === "shift" && (isLetter || isDigit || isSymbol)) {
    return undefined;
  }

  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier));
  return [...ordered, key === "pageup" ? "pageUp" : key === "pagedown" ? "pageDown" : key].join("+");
}

export function displayShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => {
      if (process.platform === "darwin" && part.toLowerCase() === "alt") return "Option";
      return part.length === 1 ? part.toUpperCase() : `${part[0]?.toUpperCase()}${part.slice(1)}`;
    })
    .join("+");
}

const KEYBOARD_SOURCE = /InputSourceKind = "(?:Keyboard Layout|Keyboard Input Method|Input Mode)"/g;

function macCtrlSpaceSwitchesInput(): boolean {
  try {
    const enabledSources = execFileSync(
      "/usr/bin/defaults",
      ["read", "com.apple.HIToolbox", "AppleEnabledInputSources"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 },
    );
    return (enabledSources.match(KEYBOARD_SOURCE)?.length ?? 0) > 1;
  } catch {
    // Unknown counts as taken; the fallback works everywhere.
    return true;
  }
}

/** fcitx toggles on Ctrl+Space by default; IBus and GNOME use Super+Space. */
function linuxCtrlSpaceSwitchesInput(env: NodeJS.ProcessEnv): boolean {
  return [env.XMODIFIERS, env.GTK_IM_MODULE, env.QT_IM_MODULE].some((value) =>
    value?.includes("fcitx"),
  );
}

/** Only used when no settings file has been written yet. */
export function defaultShortcut(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin" && macCtrlSpaceSwitchesInput()) return FALLBACK_SHORTCUT;
  if (platform === "linux" && linuxCtrlSpaceSwitchesInput(env)) return FALLBACK_SHORTCUT;
  return PREFERRED_SHORTCUT;
}
