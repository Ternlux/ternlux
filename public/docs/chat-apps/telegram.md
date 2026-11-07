# Telegram

Talk to the Ternlux assistant from a Telegram direct message. Everything in
[Chat apps](README.md) applies; this page covers what is specific to Telegram.

## Set it up

1. In Telegram, open **@BotFather**, send `/newbot`, choose a name and a
   username ending in `bot`, and copy the token it gives you.
2. In Ternlux, open **Settings → Telegram**, paste the token and press
   **Connect**. The token is encrypted on your computer.
3. Make sure the bridge is switched **on**.
4. Press **Create a pairing code** and send it to your bot as `/pair 123456`
   (or open the link shown on your phone). The code works once and expires
   after 10 minutes.

## Commands

Commands start with a slash:

| Command | What it does |
| --- | --- |
| `/new` | Start a new conversation. The previous one stays in the app's chat history. |
| `/cancel` | Stop what the bot is doing: an answer in progress, a workflow build, or an approval waiting on a button. A step that is already running finishes first. |
| `/help` | Show what the bot can do. |
| `/pair 123456` | Pair your Telegram account with a code from Settings → Telegram. |

Anything else you type is a question for the assistant.

## How things look in Telegram

- **Approvals** show the description first; the code is folded away under
  *Code — tap to expand*. Tap **Run it** or **Don't run**.
- **Workflow plans** list each step with a coloured square for its type
  (🟦 data source, 🟪 transformer, 🟧 join, 🟥 output), its inputs and its
  description, with **Build it** / **Cancel**.
- While the bot works, Telegram shows it as *typing…*.

## Files

Send the file as a **file** (not as a photo). The caption names the
connection. Telegram lets a bot download at most **20 MB**; add bigger files
in Ternlux → Connections.

## If messages are not answered

- Ternlux must be open, the bridge switched on in Settings → Telegram.
- Your account must be paired — a stranger gets "This bot is private".
- Messages sent while Ternlux was closed are answered when it opens again.
