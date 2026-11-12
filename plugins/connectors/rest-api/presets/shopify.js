/**
 * Shopify Admin API preset (custom-app access token).
 *
 * Facts cross-checked against Shopify's Admin GraphQL and REST docs, the
 * Airbyte source-shopify docs (orders, refunds, transactions, customers,
 * products, inventory, fulfillments streams; bulk operations for large
 * shops) and the n8n Shopify node (product and order CRUD). Only facts about
 * the vendor's API are recorded here.
 */

module.exports = {
  id: 'shopify',
  title: 'Shopify',
  description: 'Orders, refunds, transactions, customers, products and variants, inventory, fulfillments, discounts and collections.',
  docsUrl: 'https://shopify.dev/docs/api/admin-graphql',
  baseUrl: null,
  baseUrlPlaceholder: 'https://yourstore.myshopify.com/admin/api/2026-07',
  baseUrlHelp: 'Your *.myshopify.com address + /admin/api/<version>. Versions are quarterly (2026-04, 2026-07…) and each is supported for a year.',

  credentials: [
    { key: 'Access token', label: 'Admin API access token', placeholder: 'shpat_…',
      helpText: 'Shopify admin → Settings → Apps and sales channels → Develop apps → Create an app → Configure Admin API scopes (read_orders, read_customers, read_products, read_inventory…) → Install → reveal the Admin API access token.' },
  ],

  headers: { 'X-Shopify-Access-Token': '{Access token}', 'Content-Type': 'application/json' },

  test: { path: '/shop.json', identityField: 'shop.name' },

  pagination: 'GraphQL: first: 250 and after: <pageInfo.endCursor> while pageInfo.hasNextPage. '
    + 'REST: limit=250; follow the Link header rel="next" URL (it carries page_info) until there is none.',

  endpoints: [
    { method: 'POST', path: '/graphql.json', operation: 'orders', rows: '`data.orders.edges[].node`', label: 'Orders (GraphQL)',
      params: 'body: { query: "query($c:String){ orders(first:250, after:$c, query:\\"updated_at:>=2025-01-01\\", sortKey:UPDATED_AT){ pageInfo{hasNextPage endCursor} edges{ node{ id name createdAt displayFinancialStatus displayFulfillmentStatus totalPriceSet{shopMoney{amount currencyCode}} customer{ id email } lineItems(first:50){ edges{ node{ sku title quantity originalUnitPriceSet{shopMoney{amount}} } } } } } } }", variables: { c: null } }' },
    { method: 'POST', path: '/graphql.json', operation: 'customers', rows: '`data.customers.edges[].node`', label: 'Customers (GraphQL)',
      params: 'body: { query: "{ customers(first:250, query:\\"updated_at:>=2025-01-01\\"){ pageInfo{hasNextPage endCursor} edges{ node{ id email firstName lastName numberOfOrders amountSpent{amount currencyCode} createdAt tags } } } }" }' },
    { method: 'POST', path: '/graphql.json', operation: 'products', rows: '`data.products.edges[].node`', label: 'Products and variants (GraphQL)',
      params: 'body: { query: "{ products(first:250){ pageInfo{hasNextPage endCursor} edges{ node{ id title status vendor productType variants(first:100){ edges{ node{ id sku price inventoryQuantity } } } } } } }" }' },
    { method: 'POST', path: '/graphql.json', operation: 'bulkOperationRunQuery', rows: 'none — poll currentBulkOperation until status COMPLETED, then GET its url (JSONL: tools.parseJsonLines)',
      label: 'Bulk export (whole history of orders, products…)', params: 'body: { query: "mutation { bulkOperationRunQuery(query: \\"\\"\\" { orders { edges { node { id name createdAt } } } } \\"\\"\\") { bulkOperation { id status } userErrors { message } } }" }',
      notes: 'Poll { currentBulkOperation { status url objectCount } } every few seconds (tools.sleep). Download the url without auth headers.' },
    { path: '/orders.json', rows: '`orders` array', label: 'Orders (REST)', params: 'status=any, limit=250, updated_at_min=<ISO>, fields=id,name,total_price,created_at,financial_status' },
    { path: '/customers.json', rows: '`customers` array', label: 'Customers (REST)', params: 'limit=250, updated_at_min' },
    { path: '/orders/{order_id}/refunds.json', rows: '`refunds` array', label: 'Refunds of an order (REST)' },
    { path: '/locations.json', rows: '`locations` array', label: 'Locations' },
    { path: '/inventory_levels.json', rows: '`inventory_levels` array', label: 'Inventory levels', params: 'location_ids=<id,…> or inventory_item_ids=<id,…>, limit=250' },
  ],

  notes: [
    'GraphQL ids are gid://shopify/Order/123; REST ids are the trailing number.',
    'Money comes as strings in the shop currency (amount). GraphQL errors arrive with HTTP 200 in response.data.errors — throw on them.',
    'GraphQL has a cost budget (throttleStatus in extensions.cost); REST allows 2 requests a second (leaky bucket) — on 429 wait Retry-After.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/graphql.json', operation: 'customerCreate', label: 'Create a customer', batch: 1, upsert: null,
        body: '{ query: "mutation($i: CustomerInput!){ customerCreate(input:$i){ customer{ id } userErrors{ field message } } }", variables: { i: { email, firstName, lastName, tags: ["…"] } } }' },
      { method: 'POST', path: '/graphql.json', operation: 'customerUpdate', label: 'Update a customer', batch: 1, upsert: 'customer gid',
        body: '{ query: "mutation($i: CustomerInput!){ customerUpdate(input:$i){ customer{ id } userErrors{ message } } }", variables: { i: { id: "gid://shopify/Customer/…", … } } }' },
      { method: 'POST', path: '/graphql.json', operation: 'customers(query: email)', label: 'Find a customer by email first', batch: 1, upsert: null,
        body: '{ query: "{ customers(first:1, query:\\"email:a@b.com\\"){ edges{ node{ id } } } }" }' },
      { method: 'POST', path: '/graphql.json', operation: 'tagsAdd', label: 'Tag an order, customer or product', batch: 1, upsert: null,
        body: '{ query: "mutation($id: ID!, $t: [String!]!){ tagsAdd(id:$id, tags:$t){ userErrors{ message } } }", variables: { id, t: ["…"] } }' },
    ],
    notes: ['userErrors in each mutation\'s response list per-record failures even with HTTP 200. The app needs the matching write_* scopes.'],
  },
};
