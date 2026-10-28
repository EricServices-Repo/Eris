# REC-36 / #81: negotiated language actions and explicit debugger adapters

Source baseline main d9f7a1d, implemented 2026-10-28. Capability descriptors are version 1. Supported features are independent of agent task/effect authority; no new agent tool is registered.

## Language capabilities and edits

LspSession retains initialize-result server capabilities. TypeScript/JavaScript and extra language servers expose readiness plus advertised hover, definition, references, completion, formatting, rename and code-action support. Unready/missing/false capabilities do not enable new edit commands. A routing defect was corrected: unknown extensions no longer default to TypeScript, so a configured Python/other extension actually reaches its own server. Existing basic query fallback behavior remains; new edit requests are explicitly negotiated.

The editor exposes Format preview, Rename preview and Code actions, with unsupported commands disabled and explanations. These are current-document text edits only. Resource operations, multi-file edits, command-bearing actions, overlapping ranges, out-of-range UTF-16 positions and stale LSP document versions are refused. A rejected action cannot grant process/network effects via workspace/executeCommand. Provider annotations and unsupported edit shapes fail closed rather than being guessed.

Only saved clean text matching disk can be requested. Main captures a mutation plan before bounded source reading, checks identity before and after the LSP request, synchronizes that saved document to its server, and rejects a stale server response. Per-preview limits: 2 MB source bytes, 2000 text edits, 4 MB retained before/after UTF-16 text; 16 MB total cached preview text, maximum 32 entries, 120-second expiry. A code-action request returns at most 16 candidates. Preview tokens are bound to main-window owner and canonical workspace, consumed once before write admission, and rechecked against current root/trust. Confirmation uses the existing project write lease and journaled publishWorkspaceText with the original mutation plan. Disk changes between preview and confirmation produce conflict. No new multi-file transaction semantics are claimed.

Renderer snapshots include live Monaco content. A changed/closed/switched document cannot accept an old preview. Confirmation temporarily makes the active editor read-only; a newer buffer appearing during asynchronous publication is preserved with a reconciliation error. Applying publishes to disk and updates the editor through its existing change path; the tab can remain dirty until the ordinary save flow reconciles it. Preview is not an autonomous formatter or auto-save feature.

## Debugger capability boundaries

Launch configuration loading preserves type/request; unsupported Python/remote/attach configurations are no longer rewritten into Node launch. Node inspector remains a separate versioned adapter: workspace-bounded Node launch, breakpoints and stepping. It uses an ephemeral loopback endpoint parsed from its own child's stderr, rather than probing a guessed port belonging to another process. Inspector endpoint flags are adapter-owned. Child/session identity fences prevent old output, callbacks and pending timers from mutating replacement sessions. The UI explains that Node's variables/watch/exception UI is unavailable.

Optional DAP adapters are explicitly installed/configured by the user; none are auto-downloaded, discovered from repo/model prose or executed from workspace settings. In the user settings JSON, for example:

```json
{"intelligence":{"debugAdapters":[{"id":"python-local","command":"/absolute/path/to/python","args":["-m","debugpy.adapter"],"enabled":true}]}}
```

Then select an explicit workspace launch configuration, for example:

```json
{"configurations":[{"id":"python-entry","name":"Python via installed adapter","type":"dap:python-local","request":"launch","program":"app.py"}]}
```

DAP attach requires request `attach` plus an integer `port`; only 127.0.0.1/localhost is accepted and the adapter receives 127.0.0.1. Hostnames, remote attach, runInTerminal/startDebugging reverse requests and dynamic process/network capability expansion are unsupported. Adapter launch uses stdio with the existing Windows-aware executable resolver. The adapter executable itself is trusted local code with OS user rights, not sandboxed code; a declared loopback policy cannot certify arbitrary third-party code behavior.

The DAP client caps headers (16 KiB), bodies/buffer (4 MiB), pending requests (64), request deadlines (10 seconds), initialization (10 seconds), and output (200k characters). Stop uses a bounded disconnect then adapter TERM/KILL cleanup. Disconnect terminates the debuggee for launch, while attach requests detach semantics. Adapter/debugee tree behavior still requires qualification with each actual adapter. Workspace switching/application exit disposes debugger sessions. Stop remains available after trust revocation, while new effects require trusted main-window/frame and workspace. State updates go only to the main IDE window.

DAP initialize capabilities govern configurationDone and exposed exception filter options. Paused stack frames, bounded scope variables, explicit watch evaluation and advertised exception filters are available in Run & Debug. Evaluating a watch can execute code in the debuggee and requires an explicit user click; nothing automatically evaluates model output. Variables/stack/evaluation responses are tied to the pause generation. Uninstalled adapters and unsupported actions fail with explanations.

## Verification and packaged acceptance

The scripted Electron `npm run check:capabilities` fixture uses production LanguageTools and document snapshots to verify disabled actions, before/after preview, stale confirmation refusal, successful confirmation, editor unlock and late-response refusal. It stubs IPC; the backend fixtures below own publication/protocol verification.

Independent fixtures exercise split DAP frames, rejected reverse process requests, oversized-frame failure, deadline cancellation, initialize/configurationDone, launch, paused frames, variables, watch, exception filters, continue and stop. Another real stdio server fixture advertises formatting but no rename/hover, verifying non-TS routing and unsupported request rejection. The actual bundled TypeScript server negotiates and returns a rename edit. A real Node inspector child launches and stops. Edit tests cover CRLF/UTF-16, dirty buffers, version mismatch, multi-file/resource refusal, disk conflict, owner mismatch, expiry and duplicate confirmation.

Packaged acceptance matrix: bundled TS/JS and Node inspector have local source/process fixtures; the independent Python-like LSP and generic DAP fixtures cover protocol behavior only. Actual installed debugpy/codelldb/language adapters on macOS and Windows, real application breakpoints/stepping/variables, dirty-document keyboard preview and packaged permission/close recovery remain manual platform qualification. No paid model calls, installed third-party adapter, remote debugger, universal language support or signed installer certification is claimed. Multi-file refactoring remains explicitly unavailable until a coordinated disk/buffer transaction with preview is implemented.
