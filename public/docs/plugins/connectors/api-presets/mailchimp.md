# Mailchimp

Read audiences, their members and segments, campaigns, campaign reports
and per-recipient activity, and classic automations. See
[Vendor API connections](README.md) for how these connections work in
general.

## Get a key

Mailchimp's free plan works.

1. Sign up at mailchimp.com.
2. Click your avatar (top right) → **Profile → Extras → API keys**.
3. **Create A Key**, name it, and copy it. It ends in a data-center code,
   such as `…-us21`.

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | `https://<dc>.api.mailchimp.com/3.0`, where `<dc>` is the part of the key after the dash. Key `…-us21` → `https://us21.api.mailchimp.com/3.0` |
| API key | The key you copied |

**Test connection** calls `GET /ping` and shows Mailchimp's health
status.

## Sample data

The free plan comes with one audience. **Audience → Add contacts** a few
times (or import a small CSV), add tags to some, and create a segment.
Campaign reports fill up once a campaign is sent to the audience.

## What you can read

Audiences, members of an audience, segments and tags, campaigns,
campaign reports (opens, clicks, bounces), per-recipient email activity,
unsubscribes and classic automations.

## Good to know

- A member's id is the MD5 hash of their lower-cased email.
- Use `count` and `offset` to page; the assistant handles it.
- Mailchimp allows about 10 simultaneous connections per key, so fetches
  run one request at a time.

## Troubleshooting

- **401 or "API key invalid":** the data center in the base URL doesn't
  match the key's suffix.
- **404:** the base URL is missing `/3.0`.
