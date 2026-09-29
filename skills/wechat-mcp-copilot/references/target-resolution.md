# Target Resolution

Use target resolution whenever the user gives a loose name, nickname, group name, remark, official account name, or "the person/group who...".

## Tools

- Contacts: `wechat.contacts.resolve_contact`
- Sessions: `wechat.chat.resolve_session`
- Fallback list: `wechat.contacts.list_contacts`, `wechat.chat.list_sessions`

## Rules

- Prefer exact username/wxid match, then remark, nickname, display name, alias, recent session evidence.
- If a chat task mentions a person, resolve both contact and session when needed.
- If several candidates remain plausible, inspect recent session previews before choosing.
- If ambiguity survives after reasonable evidence, ask a short clarification.

## Evidence Fields

Use username/session id, display name, remark/nickname/alias, session type, recent timestamp, recent preview, and confidence.

