# Square

Payments, orders, refunds, customers, catalog items and categories, inventory counts, locations, team members and shifts.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Free sandbox is enough to try it.

1. developer.squareup.com → **Applications** → create an app.
2. Credentials tab → copy the **Sandbox** or **Production access token**.
3. Base URL: `https://connect.squareupsandbox.com/v2` for sandbox, `https://connect.squareup.com/v2` for live.

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | https://connect.squareup.com/v2 for your live account, https://connect.squareupsandbox.com/v2 for a sandbox. |
| Access token | developer.squareup.com → Applications → your app → Credentials → Production (or Sandbox) access token. |

**Test connection** calls `GET /locations`.

## Sample data

In the sandbox, open the Square Dashboard from the developer console and take a few test payments.

## What you can read

- Payments
- Orders (with line items)
- Refunds
- Customers
- Catalog (items, variations, categories, taxes, discounts)
- Inventory counts
- Locations
- Team members
- Shifts (hours worked)

## Good to know

- Money is { amount, currency } with amount in the smallest unit (cents).
- Catalog objects nest their data by type (item_data, item_variation_data) — flatten those.
- Send header Square-Version: YYYY-MM-DD only if you need a specific API version; otherwise the app's default version applies.

## Writing to Square

An Output node or a Join can send rows to Square (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Create customers
- Update customers by id — matches on customer id
- Find customers by email first
- Create or update catalog items — matches on object id (use #temp ids to create)

- Responses carry an errors array per failed object.

## Troubleshooting

- **401:** a sandbox token against the production URL, or the other way round.
