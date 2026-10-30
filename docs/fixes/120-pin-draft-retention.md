# Pin draft retention (#120)

The inspector refresh returns an explicit success/failure result. A pin submission clears its captured draft only after canonical IPC success and only if the textarea revision has not changed while pending. Failed writes retain the text and show reload/retry guidance; an older success cannot clear a newer draft, including text edited back to an identical value. The scripted Electron keyboard acceptance fixture now checks disk/validation failures and delayed success against the real component.
