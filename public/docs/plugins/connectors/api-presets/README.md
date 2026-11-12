# Vendor API connections

Ternlux ships ready-made connections for popular SaaS APIs. Each one is
the [REST API connector](../rest-api.md) with the vendor already filled
in: the base URL, how the key is sent (header, Bearer token or basic
auth), how its pages are walked, a one-call connection test and the list
of endpoints you can read. You paste a key; nothing else needs setting
up.

They work in both directions. A **Data Source** node pulls rows from them,
and an **Output** node — or a **Join** whose destination is one of them —
sends rows to them, creating or updating records there (see
[Sending rows to an API](#sending-rows-to-an-api) below). Calendly and
Typeform are read-only: their APIs do not take records, and neither do
Plausible or (here) Sentry beyond resolving issues. Services that sign in
with OAuth — Salesforce, Google Analytics, the ad platforms — are their
own connectors: see [OAuth connectors](../oauth-connectors/README.md).

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
| [Close](close.md) | Leads, contacts, opportunities, calls, emails, tasks | API key | 14-day trial |
| [Attio](attio.md) | Records of any object, lists, notes, tasks | Access token | Free plan |
| [ActiveCampaign](activecampaign.md) | Contacts, lists, campaigns, automations, deals | API key, account URL | 14-day trial |
| [Apollo.io](apollo.md) | Your contacts, accounts, deals, sequences; people and company search | API key | Free plan |
| [Zendesk](zendesk.md) | Tickets, comments, users, organizations, metrics, CSAT | Email + API token, Zendesk URL | 14-day trial |
| [Front](front.md) | Conversations, messages, inboxes, contacts, events | API token | 7-day trial |
| [Gorgias](gorgias.md) | Tickets, messages, customers, satisfaction surveys | Email + API key, helpdesk URL | 7-day trial |
| [Asana](asana.md) | Projects, sections, tasks, subtasks, comments | Personal access token | Free plan |
| [monday.com](monday.md) | Boards, items with column values, updates (GraphQL) | API token | Free plan |
| [ClickUp](clickup.md) | Spaces, lists, tasks, comments, time entries | Personal API token | Free plan |
| [GitLab](gitlab.md) | Projects, issues, merge requests, pipelines, deployments | Access token, GitLab URL | Free plan |
| [Sentry](sentry.md) | Issues, events, releases, Discover queries | Auth token, Sentry URL | Free Developer plan |
| [Smartsheet](smartsheet.md) | Sheets, rows, reports, workspaces | Access token | 30-day trial |
| [Brevo](brevo.md) | Contacts, lists, email and SMS campaigns, CRM | API key | Free plan |
| [Customer.io](customer-io.md) | Campaigns, newsletters, segments, messages | App API key (+ Track keys to send) | 14-day trial |
| [Mixpanel](mixpanel.md) | Raw events, profiles, segmentation, funnels, retention | Service account + project id | Free plan |

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

## Sending rows to an API

An Output node can write to any API connection, and so can a Join: pick
the connection as the destination. The rows are sent as records the
service creates or updates — HubSpot contacts, Airtable rows, Mailchimp
members, Jira issues.

1. In the Output form choose **Connection**, then the API connection under
   *APIs*. For a vendor connection you can pick a write endpoint, and
   choose **Update or create** (re-runs update what is there, matched on
   an email or id) or **Always create**.
2. Save. The chat opens with the node in focus: say which records to write
   and which columns go where. The assistant writes the code that sends
   the rows and shows it to you; in a plan build you approve it before the
   build goes on. Nothing is sent until the node or workflow runs.
3. Run. Rows go out in batches of the service's per-request limit (100 for
   HubSpot, 10 for Airtable, 500 for Mailchimp, one at a time for
   Pipedrive, Intercom, Freshdesk, Notion and Linear). A batch the API
   rejects stops the run, and the message says how many rows had already
   been sent — an API has no transaction to roll back, so prefer **Update
   or create**, which makes a re-run safe. Rows the service rejects one by
   one (an unknown property, an invalid email) are listed and fail the node.

Writing needs a key with **write** access. Each service's page says which
scope that is.

| Service | What it can receive |
| --- | --- |
| HubSpot | Contacts (upsert by email), companies, deals, tickets, products (create, or upsert on a unique property) |
| Airtable | Records in any table (create, or upsert on chosen fields) |
| Mailchimp | Audience members (upsert by email) and tags |
| Klaviyo | Profiles (upsert by email), list membership |
| SendGrid | Marketing contacts (upsert by email) |
| Pipedrive | Persons, organizations, deals (create; update after a lookup) |
| Intercom | Contacts (create or update), companies (upsert by company id) |
| Freshdesk | Contacts, companies, tickets |
| Notion | Rows of a shared database |
| Linear, Jira | Issues |
| Stripe | Customers (use a test-mode key unless you mean it) |
| GitHub | Issues (public on a public repository) |
| REST API (custom) | Whatever endpoint you describe |

## When a test fails

| Response | Usually means |
| --- | --- |
| 401 | The key is wrong, expired, or pasted in the wrong field |
| 403 | The key works but lacks a scope or access to that resource |
| 404 | The base URL is wrong (Jira, Freshdesk, Mailchimp) or the item isn't shared with the key (Notion, Airtable) |
| 429 | Rate limited — wait a minute and test again |

Keys are stored per connection. To rotate one, edit the connection and
paste the new key; leave the field blank to keep the stored one.
