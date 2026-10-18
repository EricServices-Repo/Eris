# Client performance checks

Run `npm run check:client` from the repository root. This checks types, tests chat
migration and partial saves, builds the app, exercises the compiled workspace
worker, and opens a hidden Electron fixture using an isolated temporary profile.

The renderer fixture checks a 10,000-row virtual list, stream subscription isolation,
persistent editor models, unsaved text, cursor and undo restoration, model disposal,
and the diff worker. Generated fixture assets stay in `.eris/cache/client-check`.
These checks establish behavior and bounds; they are not end-to-end latency benchmarks.

Chat storage uses `chats.sqlite` inside the existing workspace or user chat directory.
The first access imports existing JSON transcripts transactionally and leaves the
original files untouched. Subsequent sidebar loads read metadata only, message
history loads in pages, and new messages append atomically. A failed import reports
the source filename rather than silently hiding the conversation.
