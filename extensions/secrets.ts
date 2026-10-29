/**
 * Let the model ask for a credential without ever seeing it.
 *
 *   model  → request_secret({ name: "STRIPE_API_KEY", reason: "create a charge" })
 *   user   → Pi's native input dialog (nothing is written to the transcript)
 *   model  → uses $STRIPE_API_KEY in bash commands
 *   pi     → exports the value into the process environment and redacts it from
 *            tool output
 *
 * Secrets live in memory for the session: nothing touches disk, and they vanish
 * when Pi exits.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** name → value, for redaction. The value also lives in process.env. */
const secrets = new Map<string, string>();

function normalizeName(raw: string): string {
	const name = raw.trim().toUpperCase();
	if (!NAME_PATTERN.test(name)) {
		throw new Error(`Invalid secret name "${raw}": use letters, digits and underscores, starting with a letter or underscore`);
	}
	return name;
}

/** Longest first, so a secret that contains another secret is redacted whole. */
function redact(text: string): string {
	return [...secrets]
		.sort(([, a], [, b]) => b.length - a.length)
		.reduce((result, [name, value]) => (value ? result.split(value).join(`[secret:${name}]`) : result), text);
}

function hint(name: string, length: number): string {
	return [
		`Secret "${name}" is set for this session (${length} chars) and exported as $${name} in bash. Its value is hidden from you.`,
		`Never print or log it; tool output containing it comes back as [secret:${name}].`,
	].join("\n");
}

async function ask(ctx: ExtensionContext, name: string, reason?: string): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	const typed = await ctx.ui.input(`Secret · ${name}`, reason ?? "value");
	return typed?.trim() || undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", () => {
		// Drop captured values so a reloaded session does not inherit them unredacted.
		for (const name of secrets.keys()) delete process.env[name];
		secrets.clear();
	});

	pi.registerTool({
		name: "request_secret",
		label: "Request secret",
		description:
			"Ask the user to type a secret (API key, token, password, connection string) into a prompt. The value never enters the conversation: only the name and length come back, for this session. It is exported as $NAME for bash commands, and Pi redacts the value from tool output.",
		promptSnippet: "Ask the user for a secret without seeing its value",
		promptGuidelines: [
			"Never ask the user to paste a secret into chat and never guess one: call request_secret, then use $NAME in bash commands.",
			"Values are redacted from tool output, so do not print a secret to confirm it; check its length or a hash instead.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Identifier for the secret, e.g. STRIPE_API_KEY" }),
			reason: Type.Optional(Type.String({ description: "One line shown to the user: what the secret is used for" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const name = normalizeName(params.name);
			const existing = secrets.get(name);
			if (existing !== undefined) {
				return { content: [{ type: "text", text: hint(name, existing.length) }], details: { name } };
			}

			const value = await ask(ctx, name, params.reason);
			if (!value) {
				return {
					content: [{ type: "text", text: "The user cancelled the prompt, so the secret is not available. Do not guess it; ask what you need it for or continue without it." }],
					details: { name },
					isError: true,
				};
			}

			secrets.set(name, value);
			process.env[name] = value;
			return { content: [{ type: "text", text: hint(name, value.length) }], details: { name } };
		},
	});

	// Backstop: keep the value out of what the model sees.
	pi.on("tool_result", async (event) => {
		if (!secrets.size) return;
		return {
			content: event.content.map((block) => (block.type === "text" ? { ...block, text: redact(block.text) } : block)),
		};
	});
}
