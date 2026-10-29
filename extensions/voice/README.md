# Voice

Cloud speech-to-text for pi, modeled on [earendil-works/pi-voice](https://github.com/earendil-works/pi-voice)
but transcribing through an OpenAI-compatible `/audio/transcriptions` API instead of a
local whisper model. Defaults to OpenRouter with `openai/gpt-transcribe`.

Press `Ctrl+Space`, talk, press it again: the transcript is pasted into the editor.

## Setup

The recorder is a native module, so install it once:

```bash
cd extensions/voice && npm install
```

Credentials are pi's own: whatever you signed in with (`/login`) is what the
extension uses — no second key. `auth.ts` asks pi's `ModelRuntime.getAuth()`, so the
stored credential wins, OAuth tokens are refreshed when close to expiring, then
provider env vars, then `models.json` provider config. Nothing is copied or cached.

- OpenRouter (default): your pi sign-in, or `OPENROUTER_API_KEY`
- OpenAI: your pi sign-in, or `OPENAI_API_KEY`
- Groq: your pi sign-in, or `GROQ_API_KEY`
- Mistral: your pi sign-in, or `MISTRAL_API_KEY`
- Custom endpoint: `STT_API_KEY` if it needs one, otherwise none

That is all: the defaults are OpenRouter with `openai/gpt-transcribe`. Run
`/voice-model` if you want a different model.

## Commands

- `Ctrl+Space` (configurable) — start recording, press again to stop and transcribe
- `/voice` — same as the shortcut
- `/voice-cancel` — discard the current recording
- `/voice-model [id]` — with an id, sets it directly; without, picks from the
  provider's live list with per-second prices

Everything else is a config edit: there is no settings form. Change the file, then
press `Ctrl+Space` — settings are read per recording, so only `shortcut` needs a
`/reload` (it is bound at startup).

## Settings

Three layers, lowest precedence first:

1. built-in defaults (`settings.ts`)
2. `config.ts` — code-level defaults, edit this to make the extension yours
3. `~/.pi/agent/voice.json` — per-machine overrides, also written by `/voice-model`

So a shared checkout can ship its own provider, model, and language in `config.ts`,
and each machine can still override them in `voice.json`. Both are read
synchronously at load, which is what lets the shortcut be registered before the
session starts.

`config.ts` is the place for "my settings": anything set there applies to every
session without editing a file at runtime.

`~/.pi/agent/voice.json` — a hand-written partial file is fine, since missing fields
fall back to the layers above. Writes merge only the key that changed (the way pi's
`/settings` writes `settings.json`): `/voice-model` adds `model` and leaves every
other line alone, so `config.ts` keeps applying to the fields you never set.

| Field | Meaning |
| --- | --- |
| `provider` | Preset id: `openrouter`, `openai`, `groq`, `mistral`, `custom` |
| `baseUrl` | API root; `/audio/transcriptions` is appended |
| `model` | Model id, e.g. `openai/gpt-transcribe` |
| `language` | `auto` or an ISO-639-1 code |
| `prompt` | Optional vocabulary/context sent with each request |
| `shortcut` | Recording shortcut; `/reload` (or restart) rebinds it |
| `microphone` | `system-default` or `{ "type": "device", "id", "name" }` |
| `insert` | `paste` (editor) or `notify` |

### Credentials

`auth.ts` resolves credentials the same way pi does for chat requests:
`ModelRuntime.getAuth(providerId)` from `@earendil-works/pi-coding-agent` (pi aliases
that import to its own instance, so no second copy loads). Stored credential first,
OAuth refreshed under pi's file lock, then environment, then provider config. Falls
back to reading `auth.json` / env directly only when pi's provider list does not know
the provider (custom endpoints).

### Why not `settings.json`

Pi's own `settings.json` can carry extension keys (`additionalProperties` is open,
and a `{"voice": {...}}` block does reach `pi.getSettings().voice`), and built-in
extensions use exactly that: `codemode` reads `settings.codemode.mode` and
`inlineBudget` that way. But `pi.getSettings()` throws during extension loading, and
the recording shortcut has to be registered at load time. A separate file keeps one
source of truth for the binding, keeps toolkit writes out of the file pi also
rewrites, and matches what pi-voice itself does (`pi-voice.json` in the agent
directory). Pi's `/settings` form cannot host a Voice section either: its field list
is a closed interface with no extension hook.

## Changing models and providers

Every provider here speaks the OpenAI transcription protocol, so switching is
configuration only: set `provider` (and `baseUrl`/`model` for `custom`) in
`config.ts` or `voice.json`. `/voice-model` lists whatever the provider offers —
OpenRouter's transcription catalog comes with per-second prices, other providers use
a static list plus a free-form id. Adding another preset means adding an entry to
`PROVIDER_PRESETS` in `providers.ts`.

Credentials and headers live in `auth.ts`/`stt.ts`; switching to a provider with a
different protocol (e.g. a chat-completions audio model) needs a new client there.

## Layout

- `index.ts` — registration only; the recorder and UI load on first use
- `dictation.ts` — the one-recording-at-a-time state machine, status widget, paste-back
- `audio.ts` — microphone capture at 16 kHz mono via `@handy-computer/recorder`
- `stt.ts` — WAV encoding and the transcription request
- `auth.ts` — credentials via pi's `ModelRuntime.getAuth()`
- `providers.ts` — provider presets, model lists, raw `auth.json` fallback
- `config.ts` — code-level defaults
- `settings.ts` — layered settings read/validate/write
- `model-picker.ts` — the `/voice-model` picker
- `shortcut.ts` — shortcut validation and platform defaults

## Not included

Unlike pi-voice there is no local model, no on-device VAD, and no `transcribe_file`
tool for audio/video files. Audio is sent to the configured provider in one WAV
request per recording.

## Development

```bash
cd extensions/voice
npm run check
pi --no-extensions -e . --no-session
```
