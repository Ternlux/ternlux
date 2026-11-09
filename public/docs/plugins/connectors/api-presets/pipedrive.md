# Pipedrive

Read deals, persons, organizations, activities, products, pipelines,
stages, leads, notes and users. See [Vendor API connections](README.md)
for how these connections work in general.

## Get a token

Pipedrive has no free plan. Two free ways to try it:

- **Developer sandbox** (recommended): go to developers.pipedrive.com and
  sign up for a *Developer Sandbox account*. It doesn't expire and comes
  with sample deals, people and organizations.
- **14-day trial** of a normal account.

Then:

1. Sign in to the account.
2. Click your avatar (top right) → **Personal preferences → API**.
   (In some accounts: **Settings → Personal → API**.)
3. Copy **Your personal API token**.

The token acts as your user and sees what you can see.

## Add the connection

| Field | What to enter |
| --- | --- |
| Personal API token | The token you copied |

**Test connection** calls `GET /v1/users/me` and shows your name.

## Sample data

A sandbox already has data. In a trial, add a few organizations and
people, create deals in different stages of the pipeline, mark one
**Won** and one **Lost**, and schedule an activity.

## What you can read

Deals, persons, organizations, activities, products, pipelines and
stages (API v2), plus leads, notes, users and deal field definitions.

## Good to know

- Custom fields come back as 40-character hash keys. The assistant maps
  them to names with the field definitions (`/v1/dealFields`).
- Deal status is `open`, `won`, `lost` or `deleted`; won deals carry
  `won_time`.
- Stage ids map to names through `/api/v2/stages`.

## Writing to Pipedrive

An Output node or a Join can send rows to Pipedrive (see [Sending rows to an API](README.md#sending-rows-to-an-api)). The personal API token can write. Pipedrive has no upsert, so the assistant looks a person or organization up first and updates it, which keeps re-runs from duplicating.

## Troubleshooting

- **401:** the token was reset — copy it again from the API page.
- **402 or 403:** the trial has ended or the user lost access.
