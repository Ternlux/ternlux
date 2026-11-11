# Close

Leads, contacts, opportunities, activities (calls, emails, SMS, notes, meetings), tasks and pipelines.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

14-day free trial is enough to try it.

1. Sign in to Close (a 14-day trial is enough).
2. Settings → Developer → API Keys → **+ New API Key**.
3. Name it and copy the key (`api_…`).

## Add the connection

| Field | What to enter |
| --- | --- |
| API key | Close → Settings → Developer → API Keys → + New API Key. |

**Test connection** calls `GET /me/`.

## Sample data

Import a few leads (Leads → Import, or add two by hand), log a call or note on one, and create an opportunity.

## What you can read

- Leads (companies, with their contacts and custom fields)
- Contacts
- Opportunities
- Every activity (filter by type)
- Calls (duration, direction, disposition)
- Emails
- Tasks
- Users
- Lead statuses
- Opportunity pipelines and their statuses
- Lead custom field definitions (names for custom.cf_… keys)

## Good to know

- Money (opportunity value) is in cents; value_period is one_time | monthly | annual.
- Custom fields appear as "custom.cf_<id>" keys; map them to names with /custom_field/lead/ (or /contact/, /opportunity/).
- Rate limits are per endpoint group; on 429 wait for the rate_reset seconds in the response.

## Writing to Close

An Output node or a Join can send rows to Close (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Create a lead (with contacts)
- Update a lead — matches on id
- Create a contact on a lead
- Update a contact — matches on id
- Create an opportunity

- No upsert: search (query=email_address:"…" or name:"…") and PUT the match, else POST.

## Troubleshooting

- **401:** the key was deleted or copied with a space.
- **Empty results:** API keys see what their user sees — check the user's role.
