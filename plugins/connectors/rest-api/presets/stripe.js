/**
 * Stripe API preset.
 *
 * Endpoint and field facts cross-checked against the vendor's public API docs,
 * the Airbyte source connector and the n8n node / credential for it. Only facts
 * about the vendor's API are recorded here; no code from either project.
 */

module.exports = {
  id: 'stripe',
  title: 'Stripe',
  description: 'Customers, charges, payments, invoices, subscriptions, products and payouts.',
  docsUrl: 'https://docs.stripe.com/api',
  baseUrl: 'https://api.stripe.com',

  credentials: [
    {
      key: 'Secret key',
      label: 'Secret or restricted key',
      placeholder: 'rk_live_… or sk_test_…',
      helpText: 'Stripe Dashboard → Developers → API keys. A restricted key with read access to the '
        + 'resources you need is safest; a test-mode key (sk_test_) works for trying it out.',
    },
  ],

  headers: {
    Authorization: 'Bearer {Secret key}',
  },

  test: { path: '/v1/customers?limit=1' },

  pagination: 'Send limit (max 100). Rows are in response.data.data; when response.data.has_more is true, '
    + 'request again with starting_after=<id of the last row>. Stop when has_more is false.',

  endpoints: [
    { path: '/v1/customers', rows: '`data` array', label: 'Customers', params: 'limit, starting_after, email, created[gte]=<unix seconds>, expand[]' },
    { path: '/v1/charges', rows: '`data` array', label: 'Charges', params: 'limit, starting_after, customer, created[gte]' },
    { path: '/v1/payment_intents', rows: '`data` array', label: 'Payment intents', params: 'limit, starting_after, customer, created[gte]' },
    { path: '/v1/invoices', rows: '`data` array', label: 'Invoices', params: 'limit, starting_after, customer, status=draft|open|paid|uncollectible|void, created[gte]' },
    { path: '/v1/subscriptions', rows: '`data` array', label: 'Subscriptions', params: 'limit, starting_after, customer, status=all|active|canceled|past_due…', notes: 'Without status=all, canceled subscriptions are left out.' },
    { path: '/v1/products', rows: '`data` array', label: 'Products', params: 'limit, starting_after, active' },
    { path: '/v1/prices', rows: '`data` array', label: 'Prices', params: 'limit, starting_after, product, active' },
    { path: '/v1/refunds', rows: '`data` array', label: 'Refunds', params: 'limit, starting_after, charge, created[gte]' },
    { path: '/v1/disputes', rows: '`data` array', label: 'Disputes', params: 'limit, starting_after, created[gte]' },
    { path: '/v1/payouts', rows: '`data` array', label: 'Payouts', params: 'limit, starting_after, status, created[gte]' },
    { path: '/v1/balance_transactions', rows: '`data` array', label: 'Balance transactions', params: 'limit, starting_after, payout, type, created[gte]' },
    { path: '/v1/checkout/sessions', rows: '`data` array', label: 'Checkout sessions', params: 'limit, starting_after, customer, created[gte]' },
    { path: '/v1/coupons', rows: '`data` array', label: 'Coupons', params: 'limit, starting_after' },
    { path: '/v1/events', rows: '`data` array', label: 'Events (last 30 days)', params: 'limit, starting_after, type, created[gte]', notes: 'Stripe keeps events for 30 days only.' },
  ],

  notes: [
    'Amounts are integers in the smallest currency unit (cents) — divide by 100 for most currencies; `currency` says which.',
    'Timestamps (created, period_start…) are Unix seconds.',
    'Bracketed params go in the query string as written: created[gte]=1735689600, expand[]=data.customer.',
    'On 429, wait and retry; restricted keys answer 403 for resources they cannot read.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/v1/customers', label: 'Create a customer', batch: 1, upsert: null,
        body: 'form-encoded: email, name, phone, description, metadata[key]=value',
        notes: 'Send an Idempotency-Key header per row (e.g. a hash of the email) so a retried request is not created twice.' },
      { method: 'POST', path: '/v1/customers/{id}', label: 'Update a customer', batch: 1, upsert: 'customer id', body: 'form-encoded fields to change' },
      { method: 'GET', path: '/v1/customers', label: 'Find a customer by email (for updates)', batch: 1, upsert: null, body: 'query: email=<email>, limit=1 — works on every API version' },
    ],
    notes: [
      'Stripe takes application/x-www-form-urlencoded bodies, NOT JSON — build them with URLSearchParams.',
      'Do not use /v1/customers/search: accounts on an API version before 2020-08-27 answer 400. List with ?email= instead.',
      'Prefer a test-mode key (sk_test_…) unless the user explicitly asks to write live data. Never create charges or payments.',
    ],
  },
};
