# #143 — bound renderer chat-history data

The transcript virtualized its DOM rows, but `loadEarlier` concatenated every page into `activeThread.messages`, so browsing history kept growing retained strings regardless of what was on screen.

Older pages now live in a separate byte-bounded `HistoryWindow` (8 MiB estimated). They are not part of `activeThread.messages`, because saves and rewinds write that array back. Keeping them apart means eviction can never truncate the canonical transcript, and save paths behave as they did for a thread with no extra pages loaded.

Loading earlier evicts the newest window pages, and loading newer evicts the oldest ones, so eviction always happens furthest from the reader. Pages reload by ordinal cursor through the existing `chats:get` paging. When evicted pages separate the window from the live tail, `historyView` shows only the window, with **Load newer messages** and **Jump to latest**, so a gap is never presented as adjacent messages. Sending a message while parked in old pages returns to the tail. Pages overlapped by a grown tail are not shown twice.

The live tail is bounded too (8 MiB estimated, at least 60 messages) for long sessions. `boundTail` advances `messageOffset`, which the database already treats as a partial save, so the dropped rows stay in SQLite and reload as earlier pages.

`VirtualList` now keeps the reader in place when rows leave the top of the list, by subtracting the height of the removed rows. It previously handled only rows added at the top.

The conversation memory dialog reports this window's estimated page bytes on its own line, separate from main-process recall memory.

Not done, so #143 stays open:

- **Shared envelope:** renderer bytes are capped and reported, but not charged against a shared context budget. A real reservation across processes needs the allocator from #131.
- **Measured residency:** the 8 MiB figures are string-size estimates. Retained renderer heap was not measured in a packaged app.
- **Search:** it covers resident messages only. An evicted page is not searched until it is reloaded, and the existing "Loaded history" status describes that. Jumping to a source outside the window is #145.
- **Keyboard:** the new buttons are standard controls, but no scripted keyboard walk through eviction was added.

Validation:

- `npx vitest run tests/chat-history-window.test.ts`: scripted coverage of the byte envelope across a 6,000-message thread, reload without lost or duplicate messages, gap presentation, tail overlap, oversized pages, resident search, and a real `ChatDatabase` save of a bounded tail.
- `npx vite build --config checks/vite.config.ts && npx electron scripts/check-client-renderer.cjs`: real Electron renderer. A row 200 rows down stays within 1 px when 100 rows above it are evicted. With the `VirtualList` change reverted, the same check fails with "Evicting older rows lost the row being read".

No packaged, live-model or hardware run.
