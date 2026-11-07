# Calendly

Read scheduled events, their invitees, event types, organization
members and routing forms. See [Vendor API connections](README.md) for
how these connections work in general.

## Get a token

Calendly's free plan works.

1. Sign up at calendly.com.
2. **Integrations & apps → API and webhooks** (or open
   calendly.com/integrations/api_webhooks).
3. Under **Personal access tokens**, **Generate new token**, name it, and
   copy it. Calendly shows it once.

## Add the connection

| Field | What to enter |
| --- | --- |
| Personal access token | The token you copied |

**Test connection** calls `GET /users/me` and shows your name.

## Sample data

Open your booking page (your event type's link) in a private window and
book two or three slots, using a second email address and answering the
invitee questions. Cancel one to have a cancelled event.

## What you can read

Your user and organization, scheduled events (meetings), an event's
invitees, event types, organization memberships, routing forms and
routing-form submissions.

## Good to know

- Most lists need a `user` or `organization` filter; it comes from
  `GET /users/me`, and the assistant reads it first.
- Resources are identified by full URIs (`https://api.calendly.com/…`).
- Scheduled events include both active and cancelled ones unless
  `status` is set.

## Troubleshooting

- **401:** the token was revoked.
- **400 "user or organization required":** the fetch is missing that
  filter; ask again and mention whose meetings you want.
- **403 on routing forms:** the plan doesn't include them.
