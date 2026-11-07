# SendGrid

Read Marketing contact lists, single sends and their stats, segments,
global email stats, templates and suppression lists (bounces, blocks,
spam reports, unsubscribes). See [Vendor API connections](README.md) for
how these connections work in general.

## Get a key

SendGrid offers a free trial.

1. Sign up at sendgrid.com. You'll be asked to turn on two-factor
   authentication.
2. **Settings → API Keys → Create API Key.**
3. Name it and choose **Restricted Access**, then set to **Read Access**:
   *Marketing*, *Stats*, *Suppressions*, *Template Engine*. (*Full Access*
   also works, but can send mail.)
4. **Create & View**, then copy the key (`SG.…`). SendGrid shows it once.

## Add the connection

| Field | What to enter |
| --- | --- |
| API key | The key you copied |

**Test connection** calls `GET /v3/scopes` and lists what the key may do.

## Sample data

- **Marketing → Contacts → Add contacts** (manually or a small CSV) and
  put them in a list.
- Stats, single sends and suppressions fill up only once mail is sent.
  To get some, verify a sender (**Settings → Sender Authentication →
  Single Sender**) and send a single send to your list.

## What you can read

Contact lists, single sends, single-send stats, segments, global stats
by day, templates, bounces, blocks, spam reports, global unsubscribes,
invalid emails and unsubscribe groups.

## Good to know

- Exporting every contact is asynchronous (start an export, then poll);
  prefer lists, stats and suppressions for analysis.
- Suppression `created` values are Unix seconds.
- Stats endpoints need a `start_date` (YYYY-MM-DD).

## Troubleshooting

- **401:** the key was deleted, or isn't the full `SG.…` string.
- **403:** the key lacks read access to that area. Edit the key's
  permissions; the key itself stays the same.
