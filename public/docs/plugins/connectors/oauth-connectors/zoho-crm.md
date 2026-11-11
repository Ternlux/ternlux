# Zoho CRM

Every module by record list or COQL; create, update and upsert records.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Open **api-console.zoho.com** (on your data centre's domain, e.g. api-console.zoho.eu) → **Add Client** → **Server-based Applications**.
2. Homepage URL: anything (e.g. https://ternlux.com). Redirect URI: `http://localhost:3000/oauth/callback`.
3. Copy the **Client ID** and **Client Secret**, pick your data centre in Ternlux, and click **Authorize**.

## Add the connection

| Field | What to enter |
| --- | --- |
| Client ID | api-console.zoho.com → your Server-based Application → Client ID (use the console of your data centre). |
| Client secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |
| Data centre | Where your Zoho account lives — the domain you sign in at. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

A free Zoho CRM account has sample leads, contacts and deals you can keep.

## What you can read

- Records of a module
- COQL query (filters, joins on lookups, aggregates)
- Search records
- Every module (find api_name)
- A module's fields
- Users

## Always up to date

Your modules, and the fields of the modules your request names, are read live for each build.

## Good to know

- Module and field names are api_names: Leads, Contacts, Accounts, Deals, Tasks, custom ones; fields like Last_Name, Account_Name, Closing_Date.
- Lookups come back as objects { id, name }; flatten to two columns.
- Each API call costs credits (per day, per edition); prefer COQL or 200-record pages over one call per record.

## Writing to Zoho CRM

An Output node or a Join can send rows here:

- Upsert records (match on unique fields) — matches on duplicate_check_fields
- Create records
- Update records by id — matches on id

- Mandatory fields: Leads and Contacts need Last_Name; Deals need Deal_Name and Stage; Accounts need Account_Name.
- Lookups take { id }: Account_Name: { id: "…" }. Picklists accept their display values.
- A record-level error does not fail the call — read each data[i].code and report the non-SUCCESS ones as failed.

## Troubleshooting

- **invalid_client:** the client was made in another data centre — use the console on your account's domain.
- **OAUTH_SCOPE_MISMATCH:** reconnect so the new scopes are granted.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
