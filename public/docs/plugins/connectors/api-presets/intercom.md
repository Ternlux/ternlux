# Intercom

Read contacts, companies, conversations (with their messages), tickets,
admins, teams, tags and segments. See [Vendor API connections](README.md)
for how these connections work in general.

## Get a token

Intercom has no free plan. Two ways to try it:

- **Developer workspace** (recommended, doesn't expire): sign up at
  app.intercom.com/a/developer-signup.
- A **14-day trial** of a normal workspace.

Then:

1. Sign in to the workspace.
2. **Settings → Integrations → Developer Hub** (or open
   app.intercom.com/a/apps/_/developer-hub).
3. **New app**, name it, pick the workspace, and create it.
4. Open the app's **Authentication** page and copy the **Access token**.

The access token reads only the workspace the app belongs to.

## Add the connection

| Field | What to enter |
| --- | --- |
| Access token | The token you copied |

**Test connection** calls `GET /me` and shows the admin it acts as.

If your workspace is hosted in the EU or Australia, change the base URL
to `https://api.eu.intercom.io` or `https://api.au.intercom.io`.

## Sample data

- **Contacts → New** for a few users and leads, with a company each.
- Start conversations from the Messenger preview (**Settings → Messenger
  → preview**), then reply, assign and close some from the inbox.
- Add a tag or two to contacts.

## What you can read

Contacts (list and filtered search), companies, conversations (list,
search, and one conversation with all its messages), tickets, admins,
teams, tags and segments.

## Good to know

- Timestamps are Unix seconds.
- Conversation lists carry only the first message; the assistant reads
  each conversation for the full thread when you ask for it.
- A contact lists its companies by id only; the assistant reads the
  company list to name them.
- Searches use Intercom's query format (`field`, `operator`, `value`).

## Writing to Intercom

An Output node or a Join can send rows to Intercom (see [Sending rows to an API](README.md#sending-rows-to-an-api)). The access token can write. A company's standard fields (industry, size, plan, website) are top-level fields, not custom attributes; custom attributes must exist in Intercom first. Companies update by `company_id`. Intercom's search takes about a minute to show new contacts.

## Troubleshooting

- **401:** the token was regenerated, or the workspace is in another
  region (change the base URL).
- **403:** the app lacks the permission; check its *Authentication*
  page's permissions.
