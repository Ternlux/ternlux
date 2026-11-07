# HubSpot

Read CRM records: contacts, companies, deals, tickets, engagements,
owners, pipelines and forms. See [Vendor API connections](README.md) for
how these connections work in general.

## Get a service key

The free HubSpot CRM works, and so does a free developer test account
(developers.hubspot.com → create a developer account → *Test accounts*),
which can be filled with sample data.

1. Sign in to the HubSpot account you want to read.
2. Click the **settings** gear (top bar).
3. In the left menu, **Integrations → Service Keys**. In a developer
   account it can be under **Development → Keys → Service Keys**.
4. **Create service key**, name it (for example *Ternlux*).
5. Add read scopes for what you need:
   - `crm.objects.contacts.read`
   - `crm.objects.companies.read`
   - `crm.objects.deals.read`
   - `tickets`
   - `crm.objects.owners.read`
   - `forms` (for marketing forms)
   - `settings.users.read` (for account users)
6. **Create**, then copy the key.

A token from an existing *legacy private app* also works in the same
field; HubSpot no longer recommends creating new ones.

## Add the connection

| Field | What to enter |
| --- | --- |
| Service key | The key you copied |

**Test connection** reads one contact (`GET /crm/v3/objects/contacts?limit=1`).

## Sample data

New accounts come with a sample contact or two. To have something to
analyze, add 3–5 companies and contacts under **CRM → Contacts /
Companies**, then create a few deals under **CRM → Deals** in different
stages, and mark one *Closed won* with a close date and amount.

## What you can read

Contacts, companies, deals, tickets, calls, emails, meetings, notes,
tasks, line items and products; a filtered search on any object ("deals
closed since…"); property definitions; owners; deal and ticket pipelines
with their stages; marketing forms; account users.

## Good to know

- Reads return only a few default fields unless the request lists the
  properties it wants. Ask for the fields you need ("deal name, amount,
  close date, stage"), or "all fields" — the assistant then reads the
  property list first.
- Fields come nested under `properties`; generated fetches flatten them
  into columns.
- Deal stages are ids (for example `closedwon`); read the deal pipelines
  to get their names.

## Troubleshooting

- **401:** the key was deleted or pasted wrong.
- **403 "missing scopes":** add the scope named in the error to the
  service key; the key itself stays the same.
