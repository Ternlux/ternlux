# Google Sheets connector

Treats a Google Sheets spreadsheet as a database — each spreadsheet
is a "schema" and each sheet inside it is a "table".

## What it lets you do

- Test that Ternlux can reach Google Sheets with your authorised
  account.
- List the sheets inside any spreadsheet you have access to.
- Inspect the columns of a sheet (Ternlux infers them from the first
  rows of the sheet).
- Run a row-fetch query against any sheet.
- Stream large sheets in batches.
- Upload data back to a new sheet.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| OAuth Client ID | Yes | Yes | — |
| OAuth Client Secret | Yes | Yes | — |
| Redirect URI | No | No | `http://localhost:3000/oauth/callback` |

The access token, refresh token, and expiry date are filled in
automatically when you authorise.

## Setting up credentials

You need to register an OAuth client in your own Google Cloud
project so Ternlux can authorise on your behalf.

### Step 1 — Open Google Cloud Console

Go to the [Google Cloud Console](https://console.cloud.google.com)
and either pick an existing project or create a new one.

### Step 2 — Enable the required APIs

Go to **APIs & Services → Enabled APIs & services** and click
**+ Enable APIs and services**. Enable both:

- **Google Sheets API**
- **Google Drive API** (Ternlux needs this to discover spreadsheets
  you have access to)

### Step 3 — Configure the OAuth consent screen

If you haven't yet, configure the consent screen:

1. Go to **APIs & Services → OAuth consent screen**.
2. Pick **External** (or **Internal** if you're inside a Google
   Workspace organisation).
3. Fill in the app name, support email, and developer contact email.
4. Add the scopes:
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/drive.file`
5. Add yourself as a test user (while the app is in "Testing"
   status).

### Step 4 — Create OAuth credentials

1. Go to **APIs & Services → Credentials**.
2. Click **+ Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Name: `Ternlux` (or whatever you like).
5. Under **Authorized redirect URIs**, add
   `http://localhost:3000/oauth/callback`.
6. Click **Create**. Google shows the **Client ID** and **Client
   Secret** — copy both.

### Step 5 — Enter the credentials in Ternlux

Paste the **Client ID** and **Client Secret** into the form. Leave
the redirect URI as the default unless you changed it in step 4.

### Step 6 — Authorise

Click **Authorize** in the form. Ternlux opens your browser at
Google's authorisation page, you sign in with the account that owns
the sheets, and consent. The browser hands back a code, Ternlux
exchanges it for tokens, and the connection is saved encrypted.

Tokens auto-refresh in the background within a five-minute buffer of
expiry, so a workflow run never lands on a stale token.

## Behaviour notes

- A spreadsheet is identified by its spreadsheet ID; a sheet by its
  sheet name.
- Schema is inferred from the first few rows of the sheet (the first
  row is treated as the header).
- When you point a Data Source node at a Google Sheet, Ternlux
  imports the data into the local SQL workspace at run time so
  downstream nodes can query it like any other table. Column names
  are sanitised; duplicates are disambiguated; types are inferred
  from the values.
- Bucket / sheet name is used as a prefix when Ternlux creates the
  local table, so importing the same sheet from different
  spreadsheets doesn't collide.
