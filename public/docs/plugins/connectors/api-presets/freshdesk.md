# Freshdesk

Read tickets and their conversations, contacts, companies, agents,
groups, time entries, satisfaction ratings and ticket field definitions.
See [Vendor API connections](README.md) for how these connections work
in general.

## Get a key

Freshdesk has a free plan; new accounts start on a trial of a paid plan.

1. Sign up at freshdesk.com and choose a helpdesk name. Your address
   becomes `https://yourcompany.freshdesk.com`.
2. Click your avatar (top right) → **Profile settings**.
3. On the right, **View API key**, complete the check, and copy the key.

The key acts as your agent and sees what you can see.

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | `https://yourcompany.freshdesk.com/api/v2` |
| API key | The key you copied |

**Test connection** calls `GET /agents/me` and shows your name.

## Sample data

New helpdesks come with sample tickets. Add more under **Tickets → New**
with different priorities, statuses and requesters, reply to and close
a few, and log time on one.

## What you can read

Tickets, a ticket's conversations (replies and notes), contacts,
companies, agents, groups, time entries, satisfaction ratings and ticket
field definitions.

## Good to know

- Status and priority are numbers: status 2 Open, 3 Pending, 4 Resolved,
  5 Closed; priority 1 Low, 2 Medium, 3 High, 4 Urgent. The assistant
  maps them to names.
- The ticket list only returns tickets from the last 30 days unless an
  `updated_since` date is given.
- Custom fields are under `custom_fields` (`cf_…`).

## Troubleshooting

- **401:** wrong key.
- **404 or a sign-in page:** the base URL is missing `/api/v2` or has the
  wrong helpdesk name.
- **403 on time entries or satisfaction ratings:** the plan doesn't
  include that feature.
