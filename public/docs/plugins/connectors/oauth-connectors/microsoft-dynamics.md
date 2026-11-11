# Microsoft Dynamics 365

Every Dataverse table — accounts, contacts, leads, opportunities, cases, custom tables — read, create, update and upsert.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Open **entra.microsoft.com** → **App registrations** → **New registration**.
2. Supported accounts: as the service needs (see below). Redirect URI: platform **Web**, `http://localhost:3000/oauth/callback`.
3. **API permissions → Add a permission**: **Dynamics CRM → user_impersonation**, delegated; then **Grant admin consent** if your tenant requires it.
4. **Certificates & secrets → New client secret**: copy the **Value** (not the Secret ID).
5. Copy the **Application (client) ID** from Overview. Paste both into Ternlux and click **Authorize**.

## Add the connection

| Field | What to enter |
| --- | --- |
| Application (client) ID | Microsoft Entra admin center → App registrations → your app → Overview. |
| Client secret | Your app → Certificates & secrets → New client secret → copy the Value. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |
| Environment URL | Power Platform admin center → Environments → your environment → Environment URL. |
| Directory (tenant) ID | Your app registration's Directory (tenant) ID, or leave "organizations" for a multi-tenant app. Optional. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

A Dynamics 365 Sales trial or a Power Apps Developer Plan environment (free) with sample data turned on.

## What you can read

- Rows of a table (accounts, contacts, leads, opportunities, incidents, custom…)
- FetchXML query (aggregates, link-entities)
- Every table (find EntitySetName)
- A table's columns and types
- The signed-in user and business unit

## Always up to date

The environment's tables, and the columns, required fields and alternate keys of the tables your request names, are read live for each build.

## Good to know

- URLs use the plural EntitySetName (/accounts, /contacts, /incidents for cases); $select uses column LogicalNames.
- GUIDs are written bare in URLs: /accounts(00000000-0000-0000-0000-000000000000).
- Dates are UTC ISO-8601. Money columns also have a _base column in the org currency.
- Throttling: 429 with Retry-After — wait that many seconds.

## Writing to Microsoft Dynamics 365

An Output node or a Join can send rows here:

- Create a row
- Update a row by id — matches on id
- Upsert on an alternate key — matches on the alternate key

- Lookups are set with "<navigation property>@odata.bind": "/<entitySet>(<guid>)" — the navigation property name, not the _…_value column.
- Choice columns take the numeric value, not the label.
- One row per request; the runtime calls the function per batch, so keep batchSize 1–25 and send them one after another.

## Troubleshooting

- **AADSTS50011:** the redirect URI in the app registration differs.
- **403 / no privileges:** your Dataverse security role cannot read that table.
- **The environment URL:** Power Platform admin center → Environments → your environment.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
