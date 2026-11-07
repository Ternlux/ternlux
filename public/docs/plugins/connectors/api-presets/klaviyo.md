# Klaviyo

Read profiles, events, metrics, lists, segments, campaigns, flows and
templates. See [Vendor API connections](README.md) for how these
connections work in general.

## Get a key

Klaviyo's free plan (up to 250 profiles) works.

1. Sign up at klaviyo.com. You can skip connecting a store.
2. Click your account name (bottom left) → **Settings → Account → API
   keys** (or **Settings → API keys**).
3. **Create Private API Key**, name it, and choose **Read-only Key**.
4. Copy the key (`pk_…`).

Use the **private** key. The 6-character *public API key* (site id) on
the same page can't read data.

## Add the connection

| Field | What to enter |
| --- | --- |
| Private API key | `pk_…` |

**Test connection** calls `GET /api/accounts` and shows your organization
name.

## Sample data

- **Audience → Lists & segments → Create list**, then add a few profiles
  by hand or import a small CSV with email, first name and a custom
  property (for example *plan*).
- Create a segment on that property.
- Events appear once something happens (a form signup, an email open,
  or events sent from a store).

## What you can read

Profiles, events, metrics (event types), lists and their profiles,
segments and their profiles, campaigns, flows and templates.

## Good to know

- Filters use Klaviyo's syntax, such as
  `greater-than(datetime,2026-01-01T00:00:00Z)`.
- Campaigns must be filtered by channel (`equals(messages.channel,'email')`);
  the assistant adds it.
- Page sizes differ by endpoint: up to 100 for profiles and events, 50
  for flows, and only 10 for lists, segments and templates. Asking for
  more is refused with HTTP 400, so the assistant follows Klaviyo's
  *next* links instead.
- Responses follow JSON:API: values sit under `attributes`; generated
  fetches flatten them.

## Troubleshooting

- **401:** a public key was used, or the private key was revoked.
- **403:** the key isn't read-capable for that scope — create a new
  read-only key.
