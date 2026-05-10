# AI providers

DagFlux uses a large language model to translate plain-language requests
into the operations that workflows execute. You bring your own key for
your preferred provider and DagFlux handles the rest.

## Contents

- [Providers](providers.md) — which providers and models DagFlux
  supports, and how it picks one
- [Skill capabilities](helpers-bundle.md) — what the AI assistant and
  generated code can use at run time
- [Embeddings](embeddings.md) — how text is turned into vectors

## At a glance

- DagFlux supports OpenAI, Anthropic Claude, and Google Gemini for
  chat-style generation, and OpenAI or Hugging Face for embeddings.
- You configure one or more keys; DagFlux automatically picks an
  available provider at request time, with a default ordering you can
  override per request.
- Decrypted keys never leave the background engine — the interactive
  layer always asks the engine to make the call on its behalf.
- When a saved chat history would push a request past the model's
  context window, DagFlux drops the oldest entries automatically until
  the request fits, leaving the new prompt intact.
