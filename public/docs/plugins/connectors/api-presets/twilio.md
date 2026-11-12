# Twilio

Messages (SMS, WhatsApp), calls, recordings, conferences, phone numbers, usage records and alerts; send messages.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Free trial with credit is enough to try it.

1. Twilio Console home → **Account Info**.
2. Copy the **Account SID** (`AC…`) and reveal and copy the **Auth Token**.

## Add the connection

| Field | What to enter |
| --- | --- |
| Account SID | Twilio Console → Account Info → Account SID. |
| Auth token | Same panel → Auth Token (click to reveal). |

**Test connection** calls `GET /Accounts/{Account SID}.json`.

## Sample data

Send yourself a few SMS from the Console's Messaging → Try it out.

## What you can read

- Messages (status, price, direction, error code)
- Calls
- Call recordings
- Conferences
- Usage and cost by day and category
- Usage and cost by month
- Your phone numbers
- Debugger alerts (older API; Monitor alerts live at monitor.twilio.com/v1/Alerts)

## Good to know

- price is a negative string in price_unit (e.g. "-0.0079" USD).
- Dates are RFC 2822 strings ("Mon, 06 Jan 2025 10:00:00 +0000") — parse with new Date().
- Filters with comparison operators go literally in the query: DateSent>=2025-01-01.

## Writing to Twilio

An Output node or a Join can send rows to Twilio (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Send an SMS or WhatsApp message

- Sending costs money per message — confirm the row count with the user before building this.

## Troubleshooting

- **401:** the auth token was rotated.
- **Trial accounts** can only send to verified numbers.
