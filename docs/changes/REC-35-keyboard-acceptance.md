# REC-35 / #80: keyboard ownership and accessibility acceptance

Source implementation dated 2026-10-28, baseline main d9f7a1d. No new model/process/network authority is introduced.

## Focus contracts

Diff review owns N/P hunk and J/K file navigation only when focus is on the review region or its noninteractive content. Inputs, buttons, links, menus, listboxes, contenteditable, Monaco, terminals and nested keyboard owners keep their keys. IME composition, modified keys and already-handled events are ignored. The region is keyboard focusable and exposes its shortcuts. Ctrl+Alt+1/2/3/4 focus the mounted composer/review/editor/inbox; these are discoverable in the command palette. A missing/unmounted region is not opened or claimed to receive focus. Settings and palette global shortcuts do not intercept modal input.

Settings (including lazy loading), workspace creation, feedback, answer feedback, setup and command palette use a shared stacked focus scope. It sets initial focus, cycles Tab/Shift+Tab among currently enabled/visible controls, handles Escape only for the top scope, marks background sibling branches inert, and restores their original inert state and the opener on close. Nested scopes restore the parent. If the opener disappears, return to the mounted composer. No focus cleanup grants an approval or executes a command.

Permission requests are nonmodal named regions with safe initial focus on Deny. Questions focus their reply input. A request returns focus only if it still owns it, so closing it does not steal focus from later manual navigation. A concise polite live region announces ready/working/permission/question/error transitions; token and thinking buffers are never mirrored into it. Errors use alerts. Review counts announce changes. Reduced-motion and forced-colors rules plus visible keyboard outlines apply across the IDE. These rules do not certify color ratios for every theme.

## Reproducible acceptance

`npm run check:accessibility` builds only check fixtures and opens a disposable Electron window, with isolated appData/userData and no provider calls. Production CreateWorkspaceModal, CommandPalette, DiffReview and approval-focus hook are exercised: composer → safe permission choice → composer; modal initial focus; forward/reverse Tab wrap; blocked background focus; nested Escape and parent restoration; modal close → composer; review-owned single keys; buttons/editor/textbox ownership; keyboard-reachable Undo invokes its fixture callback once. The runner sends native Electron Tab input and asserts movement when the document has native focus; otherwise it explicitly reports unavailable rather than certifying native keyboard delivery. CI runs the fixture on its macOS check job. The separate long-chat fixture checks bounded history focus and selection under scrolling.

Actual local execution: scripted Electron focus checks passed. Full test/typecheck/lint and performance results are recorded in the PR validation. The fixtures do not execute a real approval effect or filesystem undo: existing approval/checkpoint tests own those contracts.

## Packaged/manual acceptance matrix still required

- macOS VoiceOver: installed build, compose → permission prompt → review → conflict-safe undo → composer. Confirm accessible names/order, one stable work announcement, error/wait explanation, no per-token narration, and nested dialog return. Not run.
- Windows NVDA: same workflow, Monaco typing and menu navigation while streaming, high contrast, keyboard-only settings/model selection and agents inbox actions. Not run.
- Reduced motion: verify OS preference removes decorative animation while leaving task meaning perceivable. Source media rules added; human visual audit not run.
- Touch/pointer plus keyboard: leave a selected history range, open/close nested dialogs, return to retained control, and test a deleted opener. Automated subset passes; full packaged workflow not run.

Do not infer screen-reader or whole-IDE conformance from JSX roles or this scripted fixture. This implements shared ownership mechanisms and reproducible regression coverage; human assistive-technology and signed/packaged acceptance remain separate release work.
