import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const tips = [
  "Tip: run inline bash in prompts with !{pwd} or !{git status --short}",
  "Tip: use !command to send output to the assistant, or !!command to run it just for yourself",
  "Tip: press Ctrl+. to cycle thinking levels",
  "Tip: press Ctrl+G to edit your prompt in $VISUAL or $EDITOR, e.g. nvim",
];

function pickRandom(): string {
  return tips[Math.floor(Math.random() * tips.length)] ?? "";
}

export default function (pi: ExtensionAPI) {
  pi.on("turn_start", async (_event, ctx) => {
    ctx.ui.setWorkingMessage(pickRandom());
  });

  pi.on("turn_end", async (_event, ctx) => {
    ctx.ui.setWorkingMessage(); // Reset for next time
  });
}
