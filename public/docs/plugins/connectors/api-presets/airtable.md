# Airtable

Read bases, their tables and fields, and table records. See
[Vendor API connections](README.md) for how these connections work in
general.

## Get a token

A free Airtable plan works.

1. Sign in at airtable.com.
2. Open **airtable.com/create/tokens** (avatar → *Builder hub* →
   *Personal access tokens*).
3. **Create token** and name it.
4. **Scopes:**
   - `data.records:read`
   - `schema.bases:read`
   - `user.email:read` (the connection test reads your email)
5. **Access:** add the bases you want to read, or *All current and future
   bases*.
6. **Create token** and copy it (`pat…`). Airtable shows it once.

## Add the connection

| Field | What to enter |
| --- | --- |
| Personal access token | The token you copied |

**Test connection** calls `GET /v0/meta/whoami` and shows your email.

## Sample data

Create a base from a template (*Project tracker* or *Sales CRM* come
filled with rows), or make a table with a few typed fields (single
select, date, number, linked records) and some rows. Add the base to the
token's access.

## What you can read

The bases the token can see, the tables and fields of a base, a table's
records (with views, formulas and sorts), and single records.

## Good to know

- Base ids start with `app`, table ids with `tbl`; both appear in the
  Airtable URL. A table name works in place of its id.
- Records nest their values under `fields`; generated fetches flatten
  them.
- Empty fields are left out of a record entirely, so a column can be
  missing from some rows.
- Rate limit: 5 requests a second per base.

## Troubleshooting

- **403 on the test:** the token is missing `user.email:read`.
- **No bases listed, or 404 on a base:** the base isn't in the token's
  *Access* list. Edit the token and add it.
