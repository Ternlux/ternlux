# Chat apps (Telegram and Slack)

You can talk to the Ternlux assistant from **Telegram** or **Slack** as well as
from the chat panel in the app. It is the same assistant with the same
connections, workflows and history — the chat app is just another place to
type. Ternlux has to be open on your computer for the bot to answer: the
messages are answered by the Ternlux running on that computer.

- [Telegram](telegram.md) — setup, commands and limits for the Telegram bot
- [Slack](slack.md) — setup, commands and limits for the Slack bot

## What works the same in both

- **Private by pairing.** Anyone can message a bot, so only accounts you pair
  get answers. Pairing is a one-time 6-digit code created in
  Settings → Telegram or Settings → Slack; it works once and expires after
  10 minutes. Remove an account there to cut its access.
- **Direct messages only.** The bot does not answer in group chats or
  channels: anyone there could read your data in its replies.
- **One conversation per chat.** Each direct message with the bot is one
  ongoing conversation, with its history. The *new* command starts a fresh
  one; the old one stays in the app's chat history.
- **One thing at a time.** While the bot is working, a new message gets
  "still working"; the *cancel* command stops what it is doing.
- **Answers, charts and tables.** Charts arrive as images, tables as a short
  preview plus a CSV file.
- **Approvals.** Before generated code runs, the bot asks with **Run it** /
  **Don't run**. Only the person who asked can press them; an unanswered
  approval expires after 10 minutes.
- **Workflows.** A workflow plan arrives with **Build it** / **Cancel**. A new
  workflow is built from the chat, including any approvals or questions the
  build stops for. Changing an *existing* workflow has to be done in the app:
  if it is open there with unsaved edits, building from a chat app would
  overwrite them.
- **Files become connections.** Send a CSV, TSV, Excel (.xlsx), JSON, NDJSON,
  Parquet or Avro file and it is added as a connection you can ask about at
  once. Text sent with the file names the connection.
- **In the app.** Chat-app conversations appear in the chat panel's history,
  labelled Telegram or Slack, and update live while the app is open. A plan's
  card in the app shows what happened to it in the chat app (building,
  built, cancelled). New connections and workflows appear in their tabs.

## What a chat app cannot do (yet)

- Run or schedule a workflow.
- Change an existing workflow (build it in the app).
- Answer in group chats or channels.
- Answer while Ternlux is closed or the computer is asleep.
