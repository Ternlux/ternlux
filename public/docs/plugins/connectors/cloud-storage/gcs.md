# Google Cloud Storage connector

Object storage on Google Cloud. Authenticated by service account.

## What it lets you do

- List your buckets.
- List objects in a bucket.
- Download an object as a file.
- Upload a file as an object.
- Delete an object.
- Inspect object metadata.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| Project ID | Yes | Yes | — |
| Service Account JSON | No | Yes | — |
| Key File Path | No | Yes | — |

You must supply either the inline credentials JSON or a path to a
key file on disk — not both. The inline JSON is encrypted into the
Ternlux credential store; the path is just stored as text and read
at run time.

## Setting up credentials

### Step 1 — Open Google Cloud Console

Go to the [Google Cloud Console](https://console.cloud.google.com)
and pick the project that owns the buckets.

### Step 2 — Create a service account

1. Go to **IAM & Admin → Service Accounts**.
2. Click **+ Create Service Account**.
3. Name it (e.g. `ternlux-gcs`).
4. Click **Create and Continue**.

### Step 3 — Grant the right roles

Grant least-privilege access. The simplest way is to attach roles
when you create the service account:

- **Storage Object Admin** — read + write on objects in any bucket
  in the project (recommended for general use).
- **Storage Object Viewer** — read-only on objects.

For per-bucket access, skip the role assignment at the project level
and instead attach the service account directly to the buckets
through **Cloud Storage → Buckets → \[your bucket\] → Permissions →
Grant Access**, with the appropriate role.

### Step 4 — Generate a JSON key

1. Open the service account.
2. Go to the **Keys** tab.
3. Click **Add Key → Create new key**.
4. Pick **JSON** and click **Create**.
5. The browser downloads the key file.

### Step 5 — Enter the credentials in Ternlux

- **Project ID** — your GCP project id.
- **Service Account JSON** — paste the entire contents of the JSON
  key file. *(Recommended.)*
- **OR Key File Path** — absolute path to the JSON key file on disk
  (use this only if you'd rather Ternlux read it from disk at run
  time).

## Behaviour notes

- Listings use a forward-slash delimiter, so subfolders inside a
  bucket appear as their own entries.
- Bucket metadata includes location and storage class.
