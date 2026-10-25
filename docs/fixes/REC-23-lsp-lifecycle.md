# REC-23 / issue 69: language server session ownership

Configured sessions are keyed by canonical workspace root and a SHA-256 digest of server configuration. The TypeScript session has an explicit canonical root. Settings/workspace changes revoke ownership synchronously before disposal; in-flight starts, exits, diagnostics and responses check the exact session object. Old processes cannot delete replacements. Document versions are scoped to the owning session and stale query results are rejected.

`LspSession` owns one process, JSON-RPC connection and pending requests. Initialization has a 15 second deadline; document queries have a 10 second deadline. Cancellation/disposal rejects pending callers. Shutdown has a 1.5 second deadline followed by termination and a 500 ms escalation to SIGKILL. Deadline failure disposes only that session. Servers must publish a matching document version when they include versions in diagnostics; unversioned diagnostics retain protocol compatibility.

Validation: TypeScript, targeted ESLint and diff whitespace checks passed. GitHub CI runs the existing suite. Packaged Windows/macOS server startup, intentionally hung fake servers, rapid workspace switching and OS process cleanup remain integration qualification work; static checks do not establish those outcomes.

A shared CI error-message compatibility repair restores the Incomplete prefix for prematurely terminated model streams without weakening rejection of tool calls.
