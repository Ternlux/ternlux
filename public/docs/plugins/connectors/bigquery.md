# BigQuery connector

Google's serverless data warehouse. Different from the standard
relational connectors in three ways: identifiers are dataset-qualified,
authentication is via service account credentials, and the dialect
supports nested and repeated fields.

## What it lets you do

- Test that DagFlux can reach BigQuery with your credentials.
- List datasets and the tables and views inside each.
- List columns of any table.
- Run any BigQuery SQL query.
- Stream large query results in batches.
- Insert rows in bulk.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| Project ID | Yes | Yes | — |
| Dataset | Yes | No | — |
| Service Account JSON | Yes | Yes | — |
| Location | No | No | US |

The Service Account JSON field accepts the full service account JSON
key. The project id, dataset, and location are stored with the
connection so the assistant and previews can use them without
prompting.

## Setting up credentials

### Step 1 — Sign in to Google Cloud

Open the [Google Cloud Console](https://console.cloud.google.com)
and select the project that owns the BigQuery dataset you want to
connect to.

### Step 2 — Enable the BigQuery API

Go to **APIs & Services → Enabled APIs & services** and confirm the
**BigQuery API** is enabled. If not, click **+ Enable APIs and
services**, search for "BigQuery API", and enable it.

### Step 3 — Create a service account

1. Go to **IAM & Admin → Service Accounts**.
2. Click **+ Create Service Account**.
3. Give it a name (e.g. `dagflux-bq`) and an optional description.
4. Click **Create and Continue**.

### Step 4 — Grant the right roles

For read + write access to a dataset, grant these IAM roles to the
service account:

- **BigQuery Data Editor** — read, insert, update, delete tables in
  any dataset.
- **BigQuery Job User** — run queries.

For read-only access, replace **BigQuery Data Editor** with
**BigQuery Data Viewer**.

You can also scope access to a single dataset (recommended) by
opening the dataset in BigQuery, clicking **Sharing → Permissions**,
and granting the service account the appropriate role on that
dataset alone.

### Step 5 — Generate a JSON key

1. Open the service account you just created.
2. Go to the **Keys** tab.
3. Click **Add Key → Create new key**.
4. Select **JSON** and click **Create**.
5. The browser downloads the JSON key file. Open it and copy the
   entire contents.

### Step 6 — Enter the credentials in DagFlux

- **Project ID** — your GCP project id (e.g. `my-gcp-project`).
- **Dataset** — the dataset DagFlux should default to.
- **Service Account JSON** — paste the entire JSON key file
  contents.
- **Location** — the BigQuery region of your dataset (e.g. `US`,
  `EU`, `us-central1`). This must match the dataset's location.

## Behaviour notes

- Tables are referenced as `dataset.table`. The connector applies the
  correct backtick quoting automatically when the AI generates SQL.
- The location parameter affects which Google region your queries
  execute in.
- Nested and repeated fields (ARRAY, STRUCT) are supported in the
  dialect — they appear in column listings with their full type.
- Primary keys are not enforced in BigQuery; column listings still
  report a primary-key flag for compatibility but it's informational
  only.
- Generated AI prompts for BigQuery suggest partitioning and
  clustering when a new table is being created.
