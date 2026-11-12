/**
 * WooCommerce REST API preset.
 *
 * Facts cross-checked against WooCommerce's REST API v3 docs, the Airbyte
 * source-woocommerce manifest (https://<shop>/wp-json/wc/v3, consumer key and
 * secret over HTTPS, per_page/offset paging, modified_after filters,
 * orders/products/customers/coupons/refunds streams) and the n8n WooCommerce
 * node (product, order, customer CRUD). Only facts about the vendor's API are
 * recorded here.
 */

module.exports = {
  id: 'woocommerce',
  title: 'WooCommerce',
  description: 'Orders, order notes, refunds, customers, products and variations, categories, coupons, reviews and sales reports.',
  docsUrl: 'https://woocommerce.github.io/woocommerce-rest-api-docs/',
  baseUrl: null,
  baseUrlPlaceholder: 'https://yourstore.com/wp-json/wc/v3',
  baseUrlHelp: 'Your store\'s address + /wp-json/wc/v3 (the site must use HTTPS).',

  credentials: [
    { key: 'Consumer key', label: 'Consumer key', placeholder: 'ck_…', helpText: 'WordPress admin → WooCommerce → Settings → Advanced → REST API → Add key (Read, or Read/Write to send rows).' },
    { key: 'Consumer secret', label: 'Consumer secret', placeholder: 'cs_…', helpText: 'Shown with the key, once.' },
  ],

  basicAuth: { username: '{Consumer key}', password: '{Consumer secret}' },
  headers: { Accept: 'application/json' },

  test: { path: '/system_status', identityField: 'environment.site_url' },

  pagination: 'Send per_page (≤ 100) and page; read the X-WP-TotalPages response header and request until page > it.',

  endpoints: [
    { path: '/orders', rows: 'the body is the array', label: 'Orders (with line items)', params: 'per_page, page, status=any|processing|completed, modified_after=<ISO>, after, before, orderby=modified' },
    { path: '/orders/{id}/notes', rows: 'the body is the array', label: 'Notes on an order' },
    { path: '/orders/{id}/refunds', rows: 'the body is the array', label: 'Refunds of an order' },
    { path: '/customers', rows: 'the body is the array', label: 'Customers', params: 'per_page, page, email, role=all, modified_after' },
    { path: '/products', rows: 'the body is the array', label: 'Products', params: 'per_page, page, status, type, sku, modified_after' },
    { path: '/products/{id}/variations', rows: 'the body is the array', label: 'Variations of a variable product' },
    { path: '/products/categories', rows: 'the body is the array', label: 'Product categories' },
    { path: '/coupons', rows: 'the body is the array', label: 'Coupons' },
    { path: '/products/reviews', rows: 'the body is the array', label: 'Product reviews' },
    { path: '/reports/sales', rows: 'the body is the array (one summary)', label: 'Sales totals for a period', params: 'period=week|month|last_month|year, date_min, date_max' },
  ],

  notes: [
    'Money fields are strings in the store currency. Dates have _gmt variants — prefer them.',
    'Some hosts strip the Authorization header; if every call is 401, the host needs Basic auth passed through (or use HTTPS with the query auth WooCommerce documents).',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/customers/batch', label: 'Create and update customers in one call', batch: 100, upsert: 'id (update) — look ids up by email first',
        body: '{ create: [{ email, first_name, last_name, billing?: { … } }], update: [{ id, …fields }] }' },
      { method: 'POST', path: '/products/batch', label: 'Create and update products', batch: 100, upsert: 'id', body: '{ create: [{ name, type, regular_price, sku }], update: [{ id, regular_price? , stock_quantity? }] }' },
      { method: 'PUT', path: '/orders/{id}', label: 'Update an order (status, meta)', batch: 1, upsert: 'id', body: '{ status?, meta_data?: [{ key, value }] }' },
      { method: 'GET', path: '/customers?email={email}', label: 'Find a customer by email first', batch: 1, upsert: null, body: '—' },
    ],
    notes: ['The batch response lists create[] and update[] results in order; an item with an error object failed.'],
  },
};
