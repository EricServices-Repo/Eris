/** Actionable next steps for common tool failures; never execute a retry automatically. */
export function toolFailureRecovery(toolName: string, detail: string): string {
  const error = detail.toLowerCase()

  if (/user denied|blocked by tool policy|reviewer can only|global installs are not allowed/.test(error)) {
    return 'Do not retry this blocked action. Continue within the allowed tools, or explain what approval or mode change is needed.'
  }
  if (/read required before editing/.test(error)) {
    return 'Call the required read tool on the named existing file, inspect the returned contents, then make the edit in a new tool call. Do not overwrite the file from memory.'
  }
  if (/eacces|eperm|permission denied|not authorized|access denied|outside (?:the )?workspace/.test(error)) {
    return 'Do not repeat the same access. Check whether the target is inside the workspace and use an allowed read-only alternative; report the boundary if access is still blocked.'
  }
  if (/enoent|no such file|file not found|does not exist|cannot find (?:the )?(?:file|path)/.test(error)) {
    return 'Verify the path with tree, glob, or grep before retrying. Use a workspace-relative path and do not create a missing file unless the user requested it.'
  }
  if (/invalid (?:tool )?(?:input|argument)|missing required|required field|schema validation|expected .* (?:string|number|array)|malformed/.test(error)) {
    return 'Correct the argument shape from the tool description and make one call with valid fields; do not resend the same malformed arguments.'
  }
  if (/timed out|timeout|etimedout|rate limit|too many requests|\b429\b/.test(error)) {
    return 'Reduce the scope or use a narrower read. Retry at most once after changing the request; if it still fails, continue with available evidence and report the limit.'
  }
  if (toolName === 'run' || /command failed|process exited|exit code|test failed|typecheck failed/.test(error)) {
    return 'Read the first actionable error, inspect the referenced file, and fix or explain its cause. Do not rerun an unchanged command just to repeat the same failure.'
  }
  if (/network|fetch failed|econn|enotfound|dns|could not connect|web search failed/.test(error)) {
    return 'Try one different source or a smaller request. If connectivity still fails, answer from verified workspace evidence or state that current external facts could not be checked.'
  }
  return 'Do not repeat the identical failed call. Use the error detail to choose a different tool, a narrower input, or a clear explanation of what is blocked.'
}
