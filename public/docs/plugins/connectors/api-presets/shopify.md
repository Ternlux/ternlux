# Shopify

Orders, refunds, transactions, customers, products and variants, inventory, fulfillments, discounts and collections.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Free development store (Shopify Partners) is enough to try it.

1. Shopify admin → Settings → **Apps and sales channels** → **Develop apps** (allow custom app development if asked).
2. **Create an app** → **Configure Admin API scopes**: read_orders, read_customers, read_products, read_inventory (plus write_* to send rows).
3. **Install app** → **API credentials** → reveal and copy the **Admin API access token** (`shpat_…`, shown once).
4. Base URL: `https://yourstore.myshopify.com/admin/api/2026-07` (any supported version).

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | Your *.myshopify.com address + /admin/api/<version>. Versions are quarterly (2026-04, 2026-07…) and each is supported for a year. |
| Admin API access token | Shopify admin → Settings → Apps and sales channels → Develop apps → Create an app → Configure Admin API scopes (read_orders, read_customers, read_products, read_inventory…) → Install → reveal the Admin API access token. |

**Test connection** calls `GET /shop.json`.

## Sample data

A development store can generate test orders; or add a product and place an order with the Bogus Gateway.

## What you can read

- Orders (GraphQL)
- Customers (GraphQL)
- Products and variants (GraphQL)
- Bulk export (whole history of orders, products…)
- Orders (REST)
- Customers (REST)
- Refunds of an order (REST)
- Locations
- Inventory levels

## Good to know

- GraphQL ids are gid://shopify/Order/123; REST ids are the trailing number.
- Money comes as strings in the shop currency (amount). GraphQL errors arrive with HTTP 200 in response.data.errors — throw on them.
- GraphQL has a cost budget (throttleStatus in extensions.cost); REST allows 2 requests a second (leaky bucket) — on 429 wait Retry-After.

## Writing to Shopify

An Output node or a Join can send rows to Shopify (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Create a customer
- Update a customer — matches on customer gid
- Find a customer by email first
- Tag an order, customer or product

- userErrors in each mutation's response list per-record failures even with HTTP 200. The app needs the matching write_* scopes.

## Troubleshooting

- **403:** the app lacks the scope — add it and reinstall the app.
- **404 on a version:** the API version is retired — use a newer one in the base URL.
