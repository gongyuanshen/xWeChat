# Chats

Use this for chat sessions, message search, and message context.

## Flow

1. Resolve fuzzy target with `wechat.chat.resolve_session`.
2. For recent/latest messages, call `wechat.chat.get_messages` with a small `limit`; the default `source=auto` reads live WeChat WCDB directly.
3. For keywords, call `wechat.chat.search_messages`; the default `source=auto` uses the WCDB-derived realtime FTS index. If it is still building, retry after the index status becomes ready.
4. Use `wechat.chat.list_search_senders` when the user needs sender facets for a broad search.
5. For a hit that needs context, call `wechat.chat.get_message_around`.
6. For merged-forward chat history or AppMsg cards that only expose `server_id`, call `wechat.chat.resolve_chat_history` or `wechat.chat.resolve_app_message`.
7. Use `wechat.chat.get_message_raw` only for debugging or missing structured fields.

## Useful Tools

- `wechat.chat.list_sessions`
- `wechat.chat.resolve_session`
- `wechat.chat.get_messages`
- `wechat.chat.search_messages`
- `wechat.chat.list_search_senders`
- `wechat.chat.get_message_around`
- `wechat.chat.get_message_anchor`
- `wechat.chat.get_daily_message_counts`
- `wechat.chat.resolve_chat_history`
- `wechat.chat.resolve_app_message`

Do not scan full histories by pagination when an aggregate or search tool can answer.

## Freshness

- `list_sessions`, `resolve_session`, `get_messages`, `get_message_around`, `get_message_anchor`, `get_daily_message_counts`, and `search_messages` default to `source=auto`.
- Use `source=realtime` only when you explicitly require live WeChat WCDB and want failure instead of fallback.
- Use `source=decrypted` only for explicit legacy snapshot analysis against output databases.
- `search_messages source=auto` and `list_search_senders source=auto` use the same realtime WCDB-derived index, so single-character Chinese searches should not fall back to slow bounded scans once the index is ready.
- `get_message_raw` intentionally remains an output-snapshot debugging tool for raw decrypted fields.
