# Salesforce

Any object by SOQL (Bulk API for large extracts); create, update and upsert records — via your own External Client App.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Setup → **App Manager** → **New External Client App** (Salesforce has replaced new Connected Apps with External Client Apps).
2. Enable **OAuth**; callback URL `http://localhost:3000/oauth/callback`; scopes **Manage user data via APIs (api)** and **Perform requests at any time (refresh_token, offline_access)**. Keep **Require PKCE** on.
3. Save, wait a few minutes, then **Settings → OAuth Settings → Consumer Key and Secret** (Salesforce emails you a code).
4. In Ternlux: paste the consumer key and secret, set the sign-in URL (production, sandbox, or your My Domain) and click **Authorize**.

## Add the connection

| Field | What to enter |
| --- | --- |
| Consumer key | Setup → External Client App Manager → your app → Settings → OAuth Settings → Consumer Key and Secret. |
| Consumer secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |
| Sign-in URL | https://login.salesforce.com for production and Developer Edition, https://test.salesforce.com for a sandbox, or your My Domain URL (https://acme.my.salesforce.com) if your org blocks the generic login. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

A free **Developer Edition** org (developer.salesforce.com/signup) comes with sample accounts, contacts and opportunities.

## What you can read

- Run a SOQL query
- SOQL including deleted and archived records
- Every object in the org (find API names)
- An object's fields, types, picklist values and relationships
- Ids of records changed in a window
- Bulk API 2.0 query job (large extracts, > ~50,000 rows)
- API limits used and remaining today
- Run a saved report (summary of up to 2000 rows)

## Always up to date

The org's objects, and the fields of the objects your request names (types, picklist values, external ids, required fields), are read live for each build — custom fields added since you connected are included.

## Good to know

- For an incremental read, filter on SystemModstamp > <last run time> and ORDER BY SystemModstamp.
- Custom objects and fields end in __c; relationship names of custom lookups end in __r (SELECT Owner__r.Name …).
- Ids are 18 characters in API responses; keep them as strings.
- Every call counts against the org's daily API request limit (GET /limits); one /query page of 2000 is one call.
- INVALID_FIELD / INVALID_TYPE errors name the bad field or object — check the live account details for the exact API names.

## Writing to Salesforce

An Output node or a Join can send rows here:

- Create records (any object)
- Upsert on an external-id field — matches on the external-id field (or Id)
- Update records by Id — matches on Id

- Set allOrNone: false so one bad record does not fail the batch; report each failed item by its position.
- Required fields: Contact and Lead need LastName (Lead also Company); Opportunity needs Name, StageName and CloseDate; Account needs Name.
- A lookup to another record takes its Id (AccountId), or a reference by its external id: Account: { attributes: { type: "Account" }, My_Ext_Id__c: "A-1" }.
- Without an external-id field, re-runs duplicate records: look them up by a unique field first (SOQL IN with up to ~200 values) and update by Id, else create.
- Picklist fields accept only their listed values (see the live account details).

## Troubleshooting

- **invalid_client_id / redirect_uri_mismatch:** the app is still propagating (wait 10 minutes) or the callback URL differs.
- **API_DISABLED_FOR_ORG:** the edition has no API access (Professional needs the API add-on).
- **INVALID_FIELD:** a field name is wrong — check the live field list.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
