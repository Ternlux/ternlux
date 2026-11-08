# Vendor API connections

Ternlux ships ready-made connections for popular SaaS APIs. Each one is
the [REST API connector](../rest-api.md) with the vendor already filled
in: the base URL, how the key is sent (header, Bearer token or basic
auth), how its pages are walked, a one-call connection test and the list
of endpoints you can read. You paste a key; nothing else needs setting
up.

They are read-only sources. A Data Source node pulls rows from them; they
are not offered as an Output destination.

## The connections

| Service | What you can read | Credentials | Free way to try it |
| --- | --- | --- | --- |
| [GitHub](github.md) | Repos, issues, pull requests, commits, releases, Actions runs | Personal access token | Free account |
| [HubSpot](hubspot.md) | Contacts, companies, deals, tickets, owners, pipelines | Service key | Free CRM or developer test account |
| [Stripe](stripe.md) | Customers, charges, invoices, subscriptions, payouts | Secret or restricted key | Test mode (free, nothing is charged) |
| [Notion](notion.md) | Database rows, pages, comments, users | Internal integration secret | Free plan |
| [Airtable](airtable.md) | Bases, tables, records | Personal access token | Free plan |
| [Jira](jira.md) | Issues (JQL), projects, sprints, worklogs | Email + API token, site URL | Free plan (10 users) |
| [Pipedrive](pipedrive.md) | Deals, persons, organizations, activities | Personal API token | Developer sandbox |
| [SendGrid](sendgrid.md) | Contact lists, single sends, stats, suppressions | API key | Free trial |
| [Klaviyo](klaviyo.md) | Profiles, events, lists, segments, campaigns | Private API key | Free plan (250 profiles) |
| [Intercom](intercom.md) | Contacts, companies, conversations, tickets | Access token | Developer workspace |
| [Linear](linear.md) | Issues, projects, cycles, teams (GraphQL) | Personal API key | Free plan |
| [Mailchimp](mailchimp.md) | Audiences, members, campaigns, reports | API key, data-center URL | Free plan |
| [Freshdesk](freshdesk.md) | Tickets, conversations, contacts, agents | API key, helpdesk URL | Free plan |
| [Calendly](calendly.md) | Scheduled events, invitees, event types | Personal access token | Free plan |
| [Typeform](typeform.md) | Forms, questions, responses | Personal access token | Free plan |

Each page has the same sections: getting a key step by step, what to
put in the connection form, how to test it, how to add sample data to a
new account, and what usually goes wrong.

## Adding one

1. **Connections → New connection**, then pick the service's tile (they
   are under *API*).
2. Paste the key. Jira, Freshdesk and Mailchimp also ask for your own
   address (the base URL); Jira asks for the account email too.
3. **Test connection.** Ternlux makes one read-only call and shows the
   account it answered as. Nothing is written to the service.
4. Save. The key is encrypted on this computer; the AI only ever sees its
   name.

## Using one

- **In a workflow:** add a Data Source node, pick the connection, and
  choose an endpoint in the sidebar. The sidebar lists the endpoint's
  variables (a repository name, a list id, a date filter). Then finish in
  the node's chat: say what you want ("open issues in owner/repo updated
  this month") and the assistant writes the fetch, shows you the code and
  runs it after you approve.
- **In the chat assistant:** ask a question about the data ("what was the
  last deal closed?"). The assistant writes a fetch for that question,
  asks you to approve it, then answers from the rows.

## When a test fails

| Response | Usually means |
| --- | --- |
| 401 | The key is wrong, expired, or pasted in the wrong field |
| 403 | The key works but lacks a scope or access to that resource |
| 404 | The base URL is wrong (Jira, Freshdesk, Mailchimp) or the item isn't shared with the key (Notion, Airtable) |
| 429 | Rate limited — wait a minute and test again |

Keys are stored per connection. To rotate one, edit the connection and
paste the new key; leave the field blank to keep the stored one.
