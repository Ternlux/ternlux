# Google Drive connector

Cloud file storage. Authenticated by OAuth — Ternlux opens your
browser to authorise, captures the redirect on a local port,
exchanges the code for tokens, and stores them encrypted. Tokens
auto-refresh within a five-minute buffer of expiry.

## What it lets you do

- List the folders you have access to.
- List files in a folder.
- Download a file.
- Upload a file.
- Delete a file.
- Inspect file metadata.
- Export Google-native files (Docs, Sheets, Slides) into other
  formats — PDF, Word, Excel, plain text, etc. — at download time.
- Use the native Google file picker for selecting files in
  DataSource nodes (Ternlux fetches the picker credentials
  automatically).

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| OAuth Client ID | Yes | Yes | — |
| OAuth Client Secret | Yes | Yes | — |
| Redirect URI | No | No | `http://localhost:3000/oauth/callback` |

The access token, refresh token, and expiry are filled in
automatically when you authorise.

## Setting up credentials

### Step 1 — Open Google Cloud Console

Go to the [Google Cloud Console](https://console.cloud.google.com)
and either pick an existing project or create a new one.

### Step 2 — Enable the Google Drive API

Go to **APIs & Services → Enabled APIs & services**, click
**+ Enable APIs and services**, search for **Google Drive API**,
and enable it.

### Step 3 — Configure the OAuth consent screen

If you haven't yet:

1. Go to **APIs & Services → OAuth consent screen**.
2. Pick **External** (or **Internal** for Workspace orgs).
3. Fill in app name, support email, and developer contact.
4. Add the scopes:
   - `https://www.googleapis.com/auth/drive.file` — the safest
     default; restricts access to files Ternlux opens or creates.
   - Add `https://www.googleapis.com/auth/drive.readonly` if you
     need to read files Ternlux didn't create.
   - Add `https://www.googleapis.com/auth/drive.metadata.readonly`
     for metadata-only listing.
5. Add yourself as a test user while the app is in "Testing"
   status.

### Step 4 — Create OAuth credentials

1. Go to **APIs & Services → Credentials**.
2. Click **+ Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Name: `Ternlux`.
5. Under **Authorized redirect URIs**, add
   `http://localhost:3000/oauth/callback`.
6. Click **Create** and copy the **Client ID** and **Client
   Secret**.

### Step 5 — Enter the credentials in Ternlux

Paste the client id and secret. Leave the redirect URI as the
default unless you changed it in step 4.

### Step 6 — Authorise

Click **Authorize** in the form, sign in with the Google account
that owns the files, and consent. Ternlux saves the resulting tokens
encrypted.

## Behaviour notes

- Files are identified by Google's file IDs, not by their human file
  names. The interactive UI handles the translation for you.
- Authorised scopes cover read/write of files Ternlux created, plus
  read access to files you've explicitly granted.
- Multiple Google scopes (drive.file, drive.readonly,
  drive.metadata.readonly) are supported for different permission
  models.
