# REST API chat

The REST API chat helps you describe what data you want to pull from an
HTTP endpoint and turns that description into a custom fetch function.
The fetch function handles authentication, base URL, pagination, and
shaping of the response into rows.

## Setup

You first save a REST API connection that captures:

- The base URL.
- The authentication scheme: bearer token, API key header, HTTP basic,
  or none.
- The credentials for that scheme (stored encrypted).

You then create a Data Source node that points at this connection and
describe what you want in plain language ("pull every order from the
last 30 days", "fetch the user list across all pages").

## What the assistant generates

A single asynchronous JavaScript function expression that:

- Receives an HTTP client.
- Loops over pages (or cursor tokens, or related endpoints) as needed.
- Returns the resulting rows as an array of plain objects.

The function uses placeholder tokens, never literal credentials, when
referencing the base URL or auth header. The placeholder vocabulary
depends on the connection's auth scheme:

- **No auth** — only the base URL placeholder is available.
- **Bearer** — base URL, plus an auth header name and value, plus the
  raw bearer token (for query-string or body inclusion if the API
  needs it).
- **API key** — base URL, plus an auth header name and value, plus the
  raw API key value (the header name defaults to a sensible value if
  you didn't set one).
- **Basic** — base URL, plus a pre-built `Basic <base64>` auth header
  value, plus the raw username and password.

## Sensible defaults

The generated function uses sensible defaults you'd otherwise have to
remember:

- HTTP method defaults to GET.
- Accept header defaults to JSON.
- A timeout is applied to every request.
- Page sizes default to a reasonable number for the endpoint at hand.
- Pagination loops have an upper bound so a misbehaving API can't loop
  forever.

## Behaviour at execution time

When the workflow runs, the background engine substitutes the
placeholders with the real decrypted values just before evaluating the
function. The function then fetches everything and Ternlux writes the
returned rows into a local document collection that downstream nodes
read from.

If the API returns nothing, Ternlux still creates an empty collection
so downstream nodes have a defined source. If the API returns a single
object, Ternlux wraps it as a single-element array.
