# Slack connector

Treats a Slack workspace as a data source — channels are "tables"
and messages are "rows". Useful for archival, analytics, and
AI-assisted summaries of channel content.

## What it lets you do

- List the channels you have access to (public channels, private
  channels, DMs, and group DMs).
- Read message history from any of those channels.
- Stream large channels in batches.
- Send messages or post files into a channel as part of an Output
  node.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| OAuth Client ID | Yes | Yes | — |
| OAuth Client Secret | Yes | Yes | — |
| Redirect URI | No | No | `http://localhost:3000/oauth/callback` |

The access token, bot user id, team id, and team name are filled in
automatically when you authorise.

## Setting up credentials

You need to register a Slack App in your own workspace so DagFlux
can authorise.

### Step 1 — Open the Slack App console

Go to [api.slack.com/apps](https://api.slack.com/apps) and click
**Create New App → From scratch**. Pick a name (e.g. `DagFlux`) and
the workspace you want to install into.

### Step 2 — Add the OAuth scopes

Open **OAuth & Permissions** in the left nav. Under **Scopes →
User Token Scopes** (or **Bot Token Scopes**, depending on how you
want the integration to act), add:

- `channels:read` — list public channels
- `channels:history` — read public channel messages
- `groups:read` — list private channels
- `groups:history` — read private channel messages
- `im:read`, `im:history` — direct messages
- `mpim:read`, `mpim:history` — group DMs
- `users:read` — resolve user names
- `chat:write` — post messages (only if you'll use Slack as an
  Output destination)
- `files:write` — upload files (only for Output usage)

### Step 3 — Add the redirect URL

Still in **OAuth & Permissions**, under **Redirect URLs**, add
`http://localhost:3000/oauth/callback` and save.

### Step 4 — Find your client credentials

Go to **Basic Information** in the left nav. Copy the **Client ID**
and **Client Secret** under **App Credentials**.

### Step 5 — Enter the credentials in DagFlux

Paste the **Client ID** and **Client Secret** into the form. Leave
the redirect URI as the default unless you changed it in step 3.

### Step 6 — Authorise

Click **Authorize** in the form. Your browser opens at Slack's
consent screen and asks you to install the app into your workspace.
After approving, the browser redirects back to DagFlux with the
tokens, which are saved encrypted.

Slack tokens are long-lived — the connector does not need to refresh
them on a schedule.

## Behaviour notes

- Each channel is shown as a table in the picker.
- Slack API errors are surfaced with the specific error string Slack
  returns (e.g. `not_in_channel`, `channel_not_found`) so debugging
  is straightforward.
- The bot user id and team id are captured at authorisation time and
  used internally for write operations.
