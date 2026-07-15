# REST API connector

A generic HTTP integration. The connection captures the base URL and
authentication scheme; each Data Source node that uses it carries its
own AI-generated fetch function describing exactly which endpoints to
hit and how to paginate.

## What it lets you do

- Save a base URL and credentials once, reuse it across many Data
  Source nodes.
- For any node, describe in plain language what data you want; the AI
  generates a custom fetch function that handles authentication,
  pagination, and shaping the response into rows.
- Use four authentication schemes out of the box.

## Connection form

| Field | Required | Sensitive | Visibility | Default |
| --- | --- | --- | --- | --- |
| Base URL | No | No | Always | — |
| Authentication | Yes | No | Always | None |
| Bearer Token | No | Yes | When Auth is Bearer | — |
| API Key Header Name | No | No | When Auth is API Key | `X-API-Key` |
| API Key Value | No | Yes | When Auth is API Key | — |
| Basic Auth Username | No | No | When Auth is Basic | — |
| Basic Auth Password | No | Yes | When Auth is Basic | — |

The form shows only the fields relevant to the auth type you picked.

## Setting up credentials

The exact steps depend on the API you're integrating with. Below is
the general pattern for each auth scheme. Always read the API's own
documentation for the canonical instructions.

### Bearer token

1. Sign in to the third-party service.
2. Find the section called "API Tokens", "Personal Access Tokens",
   "Developer Settings", or similar.
3. Generate a new token. Scope it as narrowly as possible (read-only
   if you don't need to write).
4. Copy the token — most services show it only once.
5. In Ternlux, pick **Bearer Token** as the auth type and paste the
   token.

### API key (header)

1. Sign in to the third-party service and create an API key.
2. Confirm what header name the API expects (often `X-API-Key`,
   `Authorization`, or the service's custom name like
   `X-RapidAPI-Key`).
3. In Ternlux, pick **API Key (header)**, set the header name, and
   paste the key value.

### HTTP basic

1. The third party gives you a username and password (or a username
   plus an "API password").
2. In Ternlux, pick **Basic Auth** and enter both fields. Ternlux
   handles the base64 encoding required by the protocol — you don't
   need to encode anything yourself.

### No auth

For public APIs that don't require authentication, pick **None** and
leave the credential fields empty.

### Base URL

If your API has a stable base URL (e.g. `https://api.example.com/v1`),
set it here so generated fetch functions can reference it as
`{{BASE_URL}}` and you can reuse the same connection across many
Data Source nodes. If you'd rather give absolute URLs in each node,
leave the field empty.

## How a fetch function is built

When you create a Data Source node pointing at this connection and
describe what data you want, the AI generates an asynchronous
JavaScript function that:

- Receives an HTTP client.
- Loops over pages, cursor tokens, or related endpoints as the API
  requires.
- Returns rows as an array of plain objects.

The function uses placeholder tokens (`{{BASE_URL}}`,
`{{AUTH_HEADER_NAME}}`, etc.) — never literal credentials — when
referencing the connection. The placeholders are filled in with real
values only inside the background engine, just before the function
runs. The interactive layer therefore never holds a decrypted key,
and saved workflows contain no secrets even if shared.

## Behaviour notes

- The connection itself doesn't perform any request beyond the
  test-connection probe. Real fetches happen from inside the Data
  Source node's fetch function.
- A safety cap on the maximum number of pages prevents an unbounded
  API from looping forever.
- Sensible defaults are baked into generated functions: GET method,
  JSON Accept header, a request timeout, and a reasonable page size.
- If the API returns nothing, Ternlux still creates an empty
  collection so downstream nodes have a defined source.
- If the API returns a single object, Ternlux wraps it as a
  single-element array.
