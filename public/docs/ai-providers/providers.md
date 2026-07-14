# Providers and models

Ternlux talks to large language models through one in-process
dispatcher. The dispatcher knows about each supported provider, each
provider's available models, and each model's context window.

## Supported providers

### Built-in providers

- **OpenAI** — used for both chat-style generation and for embeddings.
- **Anthropic Claude** — used for chat-style generation.
- **Google Gemini** — used for chat-style generation.

### OpenAI-compatible providers

Ternlux can also talk to any provider that exposes an OpenAI-style
`/chat/completions` endpoint. These route through the same OpenAI SDK
with the base URL overridden, so they behave like a built-in provider
once configured:

- **OpenRouter** — aggregated access to many hosted models.
- **Groq** — fast hosted inference.
- **Together AI** — hosted open-model inference.
- **Mistral AI** — Mistral's hosted models.
- **NVIDIA AI** — NVIDIA's hosted model endpoints.
- **Ollama** — local model server (no API key required; any non-empty
  value is accepted).
- **LM Studio** — local model server (no API key required).
- **Custom (OpenAI-compatible)** — any other endpoint. You supply the
  base URL and model name yourself, stored alongside the key.

For the hosted OpenAI-compatible providers you configure an API key;
for the local servers (Ollama, LM Studio) no key is needed. The custom
option additionally requires you to enter a base URL before it can be
used.

You configure a key for each provider you want to use. You can have any
combination configured simultaneously.

## How a provider is chosen

Every AI call has a preferred provider (either set explicitly by the
caller or read from your saved settings). Ternlux uses the preferred
provider when its key is configured. If it isn't, Ternlux falls back
through a fixed order: OpenAI first, then Claude, then Gemini, then any
configured OpenAI-compatible provider.

If no provider has a key configured, the call returns an error and the
AI assistant tells you to set one up.

## Default models

When the caller doesn't pin a specific model, Ternlux picks a sensible
default per provider. The defaults track the latest generally-available
flagship model from each provider at the time of release. You can
override the model at any time from the settings screen — your choice
is remembered and used for every subsequent AI call.

## Context windows

Each model has a known total context budget — the maximum number of
input plus output tokens it can handle in one request. Ternlux keeps a
catalog of the major models and their context windows, with prefix
matching so date-stamped model variants resolve to the right family.
Models Ternlux doesn't recognise fall back to a conservative default
budget.

## History trimming

Per-node chats accumulate context as you converse with the assistant.
Before each request, Ternlux measures how much of the current model's
budget the new prompt, the system prompt, and the reserved response
tokens will consume. It then drops oldest history entries one by one
until the request fits.

If the new prompt by itself is too large to fit alongside the response
budget — which can't be rescued by trimming — the call fails fast with
a clear "prompt too long" error so you know to shorten or split the
request.

## Output cleanup

Ternlux automatically strips Markdown code fences from AI responses so
the parsed result is always clean JSON or clean code, regardless of
which provider is in use.
