# GitHub

Read repositories, issues, pull requests, commits, releases, Actions
runs and organization members. See [Vendor API connections](README.md)
for how these connections work in general.

## Get a token

A free GitHub account is enough.

1. Sign in at github.com.
2. Click your avatar (top right) → **Settings**.
3. At the bottom of the left menu, **Developer settings → Personal access
   tokens → Fine-grained tokens → Generate new token**.
4. Give it a name and an expiry date.
5. **Repository access:** *All repositories*, or *Only select repositories*
   for the ones you want to read.
6. **Permissions → Repository permissions**, set to **Read-only**:
   Contents, Issues, Pull requests, Metadata (always on). Add Actions,
   Deployments or Administration (for traffic) only if you need them.
   For organization members and teams, also set **Organization
   permissions → Members** to Read-only.
7. **Generate token** and copy it (`github_pat_…`). GitHub shows it once.

A classic token (`ghp_…`) also works; give it the `repo` scope (or
`public_repo` for public repositories only) and `read:org`.

## Add the connection

| Field | What to enter |
| --- | --- |
| Personal access token | The token you copied |

**Test connection** calls `GET /user` and shows your GitHub login.

## Sample data

Any repository you can see works. On a new account, create a repository
with a README, open two or three issues, add a label or two, and open a
pull request from a second branch.

## What you can read

Repositories (yours, an organization's, a user's), issues, pull requests,
commits, comments, releases, branches, tags, labels, milestones,
collaborators, stargazers, deployments, Actions workflows and runs,
contributor stats, traffic (top paths and referrers, last 14 days), and
organization members and teams.

## Good to know

- Most endpoints need an owner and repository (`owner/repo`); the
  assistant will ask for them if your request doesn't say.
- The issues endpoint also returns pull requests (they carry a
  `pull_request` field); ask for "issues only" to drop them.
- Rate limit: 5,000 requests an hour per token.
- Timestamps are ISO-8601 in UTC.

## Troubleshooting

- **401:** the token expired or was revoked — generate a new one.
- **404 on a private repository:** the fine-grained token doesn't include
  it. Edit the token's repository access.
- **403 on traffic or collaborators:** these need push or admin access to
  the repository.
