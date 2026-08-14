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

| Field | Required | Sensitive | Notes |
| --- | --- | --- | --- |
| Base URL | No | No | — |
| Parameters & Credentials | No | Values only | Up to 50 key/value entries |

### Parameters & Credentials

One row per thing the API needs: an auth header, an API key, a tenant
id, a fixed query parameter.

- Up to 50 entries per connection.
- Keys must be unique within a connection (case-insensitively).
- A row with an empty key is discarded when you save.
- Values are encrypted with the OS keychain. Editing the connection
  brings the keys back with blank values — leave one blank to keep
  what's stored, or delete the row to remove it.

The key names are public; the values are not. The AI that writes your
fetch function sees only the names and refers to each value by a
placeholder, so a key named `access_key` becomes `{{ACCESS_KEY}}` in the
generated request and is filled in at run time inside the background
engine.

Where each entry goes is decided by the generated fetch function, from
the key name and what you asked for — a request header, a query-string
parameter, or a body field. An API that wants `?access_key=...` works
the same way as one that wants an `Authorization` header; name the key
the way the API names it.

### Setting up credentials

The exact steps depend on the API. In general: sign in to the service,
create an API key or token (scope it read-only where you can), check
its documentation for the exact header or parameter name it expects,
then add that name and the value as one row here.

For public APIs that need no authentication, leave the list empty.

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

The function uses placeholder tokens (`{{BASE_URL}}`, plus one per
saved parameter, such as `{{ACCESS_KEY}}`) — never literal credentials
— when referencing the connection. The placeholders are filled in with real
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
