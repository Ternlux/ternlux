/**
 * Twilio API preset.
 *
 * Facts cross-checked against Twilio's REST API docs, the Airbyte
 * source-twilio docs and manifest (HTTP Basic with Account SID and auth token,
 * next_page_uri paging, messages / calls / recordings / usage records /
 * conversations streams) and the n8n Twilio node (send SMS, make call). Only
 * facts about the vendor's API are recorded here.
 */

module.exports = {
  id: 'twilio',
  title: 'Twilio',
  description: 'Messages (SMS, WhatsApp), calls, recordings, conferences, phone numbers, usage records and alerts; send messages.',
  docsUrl: 'https://www.twilio.com/docs/usage/api',
  baseUrl: 'https://api.twilio.com/2010-04-01',

  credentials: [
    { key: 'Account SID', label: 'Account SID', placeholder: 'AC…', helpText: 'Twilio Console → Account Info → Account SID.' },
    { key: 'Auth token', label: 'Auth token', placeholder: 'Auth token', helpText: 'Same panel → Auth Token (click to reveal).' },
  ],

  basicAuth: { username: '{Account SID}', password: '{Auth token}' },
  headers: { Accept: 'application/json' },

  test: { path: '/Accounts/{Account SID}.json', identityField: 'friendly_name' },

  pagination: 'Send PageSize (≤ 1000); while response.data.next_page_uri is set, GET "https://api.twilio.com" + next_page_uri.',

  endpoints: [
    { path: '/Accounts/{AccountSid}/Messages.json', rows: '`messages` array', label: 'Messages (status, price, direction, error code)',
      params: 'PageSize, DateSent>=YYYY-MM-DD, DateSent<=YYYY-MM-DD, To, From', notes: '{AccountSid} is the Account SID field — use its placeholder.' },
    { path: '/Accounts/{AccountSid}/Calls.json', rows: '`calls` array', label: 'Calls', params: 'PageSize, StartTime>=YYYY-MM-DD, Status, To, From' },
    { path: '/Accounts/{AccountSid}/Recordings.json', rows: '`recordings` array', label: 'Call recordings', params: 'PageSize, DateCreated>=' },
    { path: '/Accounts/{AccountSid}/Conferences.json', rows: '`conferences` array', label: 'Conferences' },
    { path: '/Accounts/{AccountSid}/Usage/Records/Daily.json', rows: '`usage_records` array', label: 'Usage and cost by day and category', params: 'StartDate, EndDate, Category=sms|calls|totalprice…, PageSize' },
    { path: '/Accounts/{AccountSid}/Usage/Records/Monthly.json', rows: '`usage_records` array', label: 'Usage and cost by month', params: 'StartDate, EndDate, Category' },
    { path: '/Accounts/{AccountSid}/IncomingPhoneNumbers.json', rows: '`incoming_phone_numbers` array', label: 'Your phone numbers' },
    { path: '/Accounts/{AccountSid}/Notifications.json', rows: '`notifications` array', label: 'Debugger alerts (older API; Monitor alerts live at monitor.twilio.com/v1/Alerts)' },
  ],

  notes: [
    'price is a negative string in price_unit (e.g. "-0.0079" USD).',
    'Dates are RFC 2822 strings ("Mon, 06 Jan 2025 10:00:00 +0000") — parse with new Date().',
    'Filters with comparison operators go literally in the query: DateSent>=2025-01-01.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/Accounts/{AccountSid}/Messages.json', label: 'Send an SMS or WhatsApp message', batch: 1, upsert: null,
        body: 'form-encoded (application/x-www-form-urlencoded): To=+15551234567, From=+15557654321 (or MessagingServiceSid=MG…), Body=…',
        notes: 'Every row sends a real, billed message. WhatsApp numbers are written whatsapp:+1555….' },
    ],
    notes: ['Sending costs money per message — confirm the row count with the user before building this.'],
  },
};
