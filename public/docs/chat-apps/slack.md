# Slack

Talk to the Ternlux assistant from a Slack direct message. Everything in
[Chat apps](README.md) applies; this page covers what is specific to Slack.

## One bot per computer

Each computer running Ternlux gets **its own Slack app and bot**, named after
the computer (for example *Ternlux · MacBook Air 13*, found in Slack as
`@ternlux-macbookair13`). The bot you message is the computer that answers.
Two computers never share a bot: Slack would split the messages between them.

On Slack's free plan a workspace can install up to 10 apps in total, and each
computer's bot counts as one. Some workspaces need an admin to approve new
apps.

## Set it up

In Ternlux, open **Settings → Slack** and follow the three steps:

1. **Create the app.** Name this computer's bot and press
   **Create the Slack app** — Slack opens with the app's settings filled in;
   pick your workspace and confirm. (If the page opens empty, use
   **Copy manifest instead** and paste it under *Create New App → From an app
   manifest*.)
2. **App-level token.** In the app's page in Slack: *Basic Information →
   App-Level Tokens → Generate Token and Scopes*, add the scope
   `connections:write`, and paste the token (it starts with `xapp-`).
3. **Bot token.** *Install App → Install to Workspace*, then paste the
   *Bot User OAuth Token* (it starts with `xoxb-`) and press **Connect**.

Then press **Create a pairing code** and, in a direct message with the bot,
send `pair 123456`. Both tokens are encrypted on your computer.

## Commands

In Slack, commands are plain words sent **as the whole message** — without a
slash, because Slack treats a leading `/` as one of its own commands:

| Send | What it does |
| --- | --- |
| `new` | Start a new conversation. The previous one stays in the app's chat history. |
| `cancel` | Stop what the bot is doing: an answer in progress, a workflow build, or an approval waiting on a button. A step that is already running finishes first. |
| `help` | Show what the bot can do. |
| `pair 123456` | Pair your Slack account with a code from Settings → Slack. |

A longer message that starts with one of these words ("new customers last
month?") is a question, not a command.

## How things look in Slack

- **Approvals** show the description with **Run it** / **Don't run**;
  **View code** opens the code in a pop-up.
- **Workflow plans** list each step with a coloured square for its type
  (🟦 data source, 🟪 transformer, 🟧 join, 🟥 output), its inputs and its
  description, with **Build it** / **Cancel**.
- While the bot works, an ⏳ reaction sits on your message (Slack shows no
  typing indicator for bots).
- If someone else presses your buttons, only they see a note that it is not
  theirs to press.

## Files

Send the file in the direct message; text in the same message names the
connection. Files up to **100 MB** are accepted.

## Channels

Mentioning the bot in a channel gets a reply in that thread saying it only
works in direct messages for now.

## If messages are not answered

- Ternlux must be open on this computer and the bridge switched on in
  Settings → Slack (it shows *connected*).
- Your Slack account must be paired.
- Make sure you are messaging this computer's bot — each computer has its own.
