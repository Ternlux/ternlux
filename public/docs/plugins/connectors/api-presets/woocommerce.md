# WooCommerce

Orders, order notes, refunds, customers, products and variations, categories, coupons, reviews and sales reports.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Your own WordPress site (any host with HTTPS) is enough to try it.

1. WordPress admin → WooCommerce → Settings → **Advanced** → **REST API** → **Add key**.
2. Pick a user, permissions **Read** (or Read/Write), **Generate API key**.
3. Copy the consumer key and secret (shown once). Base URL: `https://yourstore.com/wp-json/wc/v3`.

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | Your store's address + /wp-json/wc/v3 (the site must use HTTPS). |
| Consumer key | WordPress admin → WooCommerce → Settings → Advanced → REST API → Add key (Read, or Read/Write to send rows). |
| Consumer secret | Shown with the key, once. |

**Test connection** calls `GET /system_status`.

## Sample data

Add a product and place a test order with the Cash on delivery method.

## What you can read

- Orders (with line items)
- Notes on an order
- Refunds of an order
- Customers
- Products
- Variations of a variable product
- Product categories
- Coupons
- Product reviews
- Sales totals for a period

## Good to know

- Money fields are strings in the store currency. Dates have _gmt variants — prefer them.
- Some hosts strip the Authorization header; if every call is 401, the host needs Basic auth passed through (or use HTTPS with the query auth WooCommerce documents).

## Writing to WooCommerce

An Output node or a Join can send rows to WooCommerce (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Create and update customers in one call — matches on id (update) — look ids up by email first
- Create and update products — matches on id
- Update an order (status, meta) — matches on id

- The batch response lists create[] and update[] results in order; an item with an error object failed.

## Troubleshooting

- **401 on every call:** the host strips the Authorization header — ask the host to pass it through.
- **404:** permalinks are set to "Plain"; switch to any other setting.
