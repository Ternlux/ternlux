# Stripe

Read customers, charges, payment intents, invoices, subscriptions,
products, prices, refunds, disputes, payouts and balance transactions.
See [Vendor API connections](README.md) for how these connections work
in general.

## Get a key

Stripe's **test mode** is free and needs no business details; nothing in
it is ever charged.

1. Sign up at dashboard.stripe.com. You can skip activating payments.
2. Turn on **Test mode** (the toggle at the top right, or a *sandbox*).
3. **Developers → API keys.**
4. Copy the **Secret key** (`sk_test_…`).

For production, prefer a **restricted key**: *Create restricted key*,
set the resources you want to **Read**, leave the rest at *None*, and
copy the `rk_live_…` key.

## Add the connection

| Field | What to enter |
| --- | --- |
| Secret or restricted key | `sk_test_…`, `sk_live_…` or `rk_…` |

**Test connection** reads one customer (`GET /v1/customers?limit=1`).

## Sample data

In test mode:

- **Customers → Add customer** a few times.
- **Product catalog → Add product** with a price, then create a **payment
  link** and pay it with the test card `4242 4242 4242 4242` (any future
  date, any CVC). That creates a charge, a payment intent and a customer.
- An invoice: **Invoices → Create invoice** for a customer, add the
  product, and send or finalize it.

## What you can read

Customers, charges, payment intents, invoices, subscriptions, products,
prices, refunds, disputes, payouts, balance transactions, checkout
sessions, coupons and events (last 30 days).

## Good to know

- Amounts are in the smallest currency unit (cents): 2500 is $25.00.
  `currency` says which currency.
- Timestamps are Unix seconds.
- Filters use bracketed parameters, such as `created[gte]=1735689600`.
- A test key only sees test data, and a live key only live data.

## Writing to Stripe

An Output node or a Join can send rows to Stripe (see [Sending rows to an API](README.md#sending-rows-to-an-api)). Writing with a secret key creates real objects in that mode — use a **test-mode** key (`sk_test_…`) unless you mean it. Customers are found by email first so re-runs update them. Charges and payments are never created.

## Troubleshooting

- **401:** wrong key, or a publishable key (`pk_…`) — use the secret one.
- **403:** a restricted key without read access to that resource.
