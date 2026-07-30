# Yomi — Data & Privacy

Yomi reads your LINE messages on your behalf and exposes them to an AI agent.
This is the canonical statement of what it captures and how you stay in control.
It is the single source of truth: Yomi surfaces this same text to the agent on
connect (via the MCP server `instructions`) and through the `get_scope_policy`
tool.

## What Yomi captures

By default, Yomi indexes **all** of your LINE conversations into a **local,
on-device** search index (`data/search-index.db`) so an agent can search across
them. This is a capture-all default — nothing is excluded until you say so.

## Where your data goes

Everything stays **on your machine**. Yomi never uploads your messages anywhere.
The only data that leaves your device is whatever the agent surfaces in its
replies to you — and in a cloud assistant, that surfaced text is processed by
that assistant's model. Yomi itself makes no outbound copy of your messages.

## The one non-LINE request Yomi makes

At startup Yomi asks the public npm registry whether a newer version has been
published, and tells the agent if so. This exists because a Desktop Extension
(`.mcpb`) installed by hand never auto-updates — without the check you could
sit on an old build, security fixes included, and never know.

It sends **no message content and no account identifier**: it is a plain GET of
a public package document. What it does reveal to the registry is that your IP
address is running Yomi, and roughly which version. Nothing is uploaded.

Set **`YOMI_NO_UPDATE_CHECK=1`** to turn it off; Yomi then makes no outbound
request except to LINE itself.

## Excluding conversations

You can exclude any conversation at any time, in plain language to the agent
(e.g. "don't index my chats with X"):

- **`exclude_chats`** — stop indexing a conversation **and delete its
  already-indexed messages** from the local index. Exclusion purges past data,
  not just future capture.
- **`include_chats`** — re-allow a previously excluded conversation.
- **`list_excluded_chats`** — see what is currently excluded.
- **`get_scope_policy`** — see this policy plus the current exclusion list.

## Consent

Because the default is capture-all, Yomi surfaces this policy to the agent on
connect so the agent can tell you the default — and that you can exclude
conversations — **before** doing any bulk read. You should get to make an
informed choice.
