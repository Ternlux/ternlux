# GitLab

Projects, groups, issues, merge requests, commits, pipelines, jobs, deployments, releases and members.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Free plan is enough to try it.

1. Avatar → **Edit profile** → **Access tokens** → **Add new token**.
2. Tick **read_api** (and **api** to send rows), set an expiry, create and copy it (`glpat-…`).
3. Base URL: `https://gitlab.com/api/v4`, or your own host + `/api/v4`.

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | https://gitlab.com/api/v4 for GitLab.com, or https://<your GitLab host>/api/v4 for self-managed. |
| Personal access token | GitLab → avatar → Edit profile → Access tokens → Add new token with the read_api scope (api to send rows). |

**Test connection** calls `GET /user`.

## Sample data

Create a project, open a few issues and a merge request; a pipeline appears once a `.gitlab-ci.yml` runs.

## What you can read

- Projects you are a member of
- Groups
- Issues of a project
- Issues of every project in a group
- Merge requests
- Commits
- CI/CD pipelines
- CI/CD jobs (duration, status, runner)
- Deployments
- Releases
- Project members (incl. inherited)

## Good to know

- Issues and merge requests have a project-wide iid (shown in the UI) and a global id; URLs for one issue use the iid.
- GitLab.com allows about 2,000 authenticated requests a minute; on 429 wait for RateLimit-Reset.

## Writing to GitLab

An Output node or a Join can send rows to GitLab (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Create an issue
- Update an issue — matches on issue iid
- Comment on an issue

- The token needs the api scope to write. Issues on a public project are public.

## Troubleshooting

- **401:** the token expired.
- **404 on a project:** use its numeric id or the URL-encoded path (`group%2Fproject`).
