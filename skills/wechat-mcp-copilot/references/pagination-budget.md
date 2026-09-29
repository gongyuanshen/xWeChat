# Pagination And Budget

Default limits:

- Contact/session candidates: 10
- Recent messages: 20
- Message search: 20
- Moments timeline: 10
- Media references: 20
- Ranking/analytics rows: 20

Hard rules:

- Keep single message/Moments pages at or below 50 unless user asks for more.
- Stop paging when enough evidence exists.
- Stop after two empty or low-value pages.
- Do not cross 500 raw messages without user confirmation.
- List responses should use ids, names, timestamps, preview, and evidence.
- Fetch full details only after a candidate or hit is selected.

