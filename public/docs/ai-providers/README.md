# AI providers

Ternlux uses a large language model to translate plain-language requests
into the operations that workflows execute. You bring your own key for
your preferred provider and Ternlux handles the rest.

## Contents

- [Providers](providers.md) — which providers and models Ternlux
  supports, and how it picks one
- [Skill capabilities](helpers-bundle.md) — what the AI assistant and
  generated code can use at run time
- [Embeddings](embeddings.md) — how text is turned into vectors

## At a glance

- Ternlux supports OpenAI, Anthropic Claude, and Google Gemini for
  chat-style generation, plus any OpenAI-compatible provider
  (OpenRouter, Groq, Together AI, Mistral AI, NVIDIA AI, Ollama, LM
  Studio, or a custom endpoint), and OpenAI for embeddings.
- You configure one or more keys; Ternlux automatically picks an
  available provider at request time, with a default ordering you can
  override per request.
- Decrypted keys never leave the background engine — the interactive
  layer always asks the engine to make the call on its behalf.
- When a saved chat history would push a request past the model's
  context window, Ternlux drops the oldest entries automatically until
  the request fits, leaving the new prompt intact.
