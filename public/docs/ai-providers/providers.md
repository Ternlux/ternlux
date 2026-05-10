# Providers and models

DagFlux talks to large language models through one in-process
dispatcher. The dispatcher knows about each supported provider, each
provider's available models, and each model's context window.

## Supported providers

- **OpenAI** — used for both chat-style generation and for embeddings.
- **Anthropic Claude** — used for chat-style generation.
- **Google Gemini** — used for chat-style generation.
- **Hugging Face** — used for embeddings only.

You configure a key for each provider you want to use. You can have any
combination configured simultaneously.

## How a provider is chosen

Every AI call has a preferred provider (either set explicitly by the
caller or read from your saved settings). DagFlux uses the preferred
provider when its key is configured. If it isn't, DagFlux falls back
through a fixed order: OpenAI first, then Claude, then Gemini.

If no provider has a key configured, the call returns an error and the
AI assistant tells you to set one up.

## Default models

When the caller doesn't pin a specific model, DagFlux picks a sensible
default per provider. The defaults track the latest generally-available
flagship model from each provider at the time of release. You can
override the model at any time from the settings screen — your choice
is remembered and used for every subsequent AI call.

## Context windows

Each model has a known total context budget — the maximum number of
input plus output tokens it can handle in one request. DagFlux keeps a
catalog of the major models and their context windows, with prefix
matching so date-stamped model variants resolve to the right family.
Models DagFlux doesn't recognise fall back to a conservative default
budget.

## History trimming

Per-node chats accumulate context as you converse with the assistant.
Before each request, DagFlux measures how much of the current model's
budget the new prompt, the system prompt, and the reserved response
tokens will consume. It then drops oldest history entries one by one
until the request fits.

If the new prompt by itself is too large to fit alongside the response
budget — which can't be rescued by trimming — the call fails fast with
a clear "prompt too long" error so you know to shorten or split the
request.

## Output cleanup

DagFlux automatically strips Markdown code fences from AI responses so
the parsed result is always clean JSON or clean code, regardless of
which provider is in use.
