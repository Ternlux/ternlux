# Typeform

Read forms, their questions, responses and workspaces. See
[Vendor API connections](README.md) for how these connections work in
general.

## Get a token

Typeform's free plan works.

1. Sign up at typeform.com.
2. Click your avatar (top right) → **Your settings → Personal tokens**
   (or open admin.typeform.com/user/tokens).
3. **Generate a new token**, name it, and choose **Custom scopes**:
   - `accounts:read` (the connection test needs it)
   - `forms:read`
   - `responses:read`
   - `workspaces:read`
4. **Generate token** and copy it (`tfp_…`). Typeform shows it once.

## Add the connection

| Field | What to enter |
| --- | --- |
| Personal access token | The token you copied |

**Test connection** calls `GET /me` and shows your account alias.

## Sample data

Create a short form with a few question types (multiple choice, rating,
short text, email), publish it, open its share link and submit it three
or four times with different answers.

## What you can read

Forms, one form with its questions, a form's responses and workspaces.

## Good to know

- Each response holds a list of answers keyed by question id; the
  assistant reads the form first to turn ids into question titles.
- A page holds at most 1,000 responses; large forms are read in date
  windows (`since`/`until`).
- The free plan keeps a limited number of responses a month.

## Troubleshooting

- **403 on the test:** the token is missing `accounts:read`.
- **403 on responses:** the token is missing `responses:read` — generate
  a new token with it.
