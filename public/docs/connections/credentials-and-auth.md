# Credentials and authentication

Ternlux treats every credential as a first-class secret. They are
encrypted at rest using the operating system's secure storage (Keychain
on macOS, Credential Store on Windows, Secret Service on Linux) and
decrypted only at the moment a connection or AI call is made.

## What's encrypted

Two kinds of secrets are kept separately:

- **AI provider keys** — your OpenAI, Anthropic, Google Gemini, and
  OpenAI-compatible provider keys, stored as a single encrypted bag. You can set,
  replace, or remove keys at any time from the settings screen.
- **Per-connection credentials** — for every saved connection, the
  sensitive fields (passwords, API keys, OAuth tokens, etc.) live in a
  separate encrypted store keyed by connection id. Updating a saved
  connection's credentials automatically closes any cached pooled
  connection so the next query reconnects with the new values.

## How a query gets its credentials

When you run a query, run a workflow, or open a preview:

1. The interactive layer asks the background engine to do the work.
2. The background engine looks up the connection's secret part by id,
   decrypts it, and merges it with the public configuration.
3. The merged configuration is handed to the connector for that one
   call.
4. Nothing about the secret crosses back into the interactive layer.

## OAuth-based connections

Some integrations (Google Drive, Google Sheets, OneDrive, SharePoint,
etc.) use OAuth instead of static credentials. For those, the
connection form shows an "Authorize" button. When you click it:

1. Ternlux opens your default browser at the provider's authorisation
   page. A one-time random state value is generated to prevent
   cross-site forgery.
2. While you're authorising, Ternlux runs a small local listener that
   the provider can redirect back to.
3. After you approve access in the browser, the provider redirects to
   the local listener with a one-time code. Ternlux exchanges that code
   for access and refresh tokens.
4. The tokens are saved into the encrypted credential store for the
   connection.
5. If you close the connection dialog before authorising, the local
   listener is shut down so the port is freed.

The whole authorisation window is five minutes. After that the local
listener times out and you have to start over.
