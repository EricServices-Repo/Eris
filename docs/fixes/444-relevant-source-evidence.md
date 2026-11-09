# Relevant, fresh source-read evidence (#444)

Workflow grounding records bounded source receipts rather than accepting any successful read count. Receipts contain canonical project-scoped paths, SHA-256 of returned source, optional line ranges and requirement IDs. Explicit existing file targets require exact identity. Topic-bound reviews require matching source terms or a recorded relative-import discovery chain; a calculator read alone cannot ground a booking review. This is a deterministic relevance floor, not proof of semantic feature coverage.

Receipts are checked against file identity/version, symlink resolution and dirty-source controls at completion. Failed reads, generated `.eris`/`.git` state, and sources outside the selected project do not count. Host-observed mutations can advance prior read lineage; external changes require another eligible read. Generic/project-wide reviews still permit any actual project source when no narrower referent was requested.

An unverified review may still ask for clarification or give explicitly general advice without inspecting the workspace. Once it starts workspace tools, those observations must meet the same relevance floor; unrelated or failed reads cannot become evidence of a completed project review.

The run retains at most 64 receipts, 80,000 characters per observation, 32 import links per source and eight discovery passes. Raw source is not copied into workflow snapshots; metadata and bounded relevant vocabulary are retained. Existing tool authorization/privacy and source storage remain authoritative. Qualification covers unrelated/exact targets, dependency discovery, ranges/hashes, dirty/external changes and project isolation; live semantic quality remains separate.
