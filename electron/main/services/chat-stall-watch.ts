/** Report each quiet interval until activity resumes or the watcher is stopped. */
export function watchForStall(quietMs: number, onStall: (quietForMs: number) => void) {
  let last = Date.now()
  let reported = 0
  const timer = setInterval(() => {
    const quiet = Date.now() - last
    if (quiet >= quietMs * (reported + 1)) {
      reported++
      try { onStall(quiet) } catch { /* diagnostics cannot stop the task */ }
    }
  }, Math.min(5_000, quietMs))
  return {
    touch() { last = Date.now(); reported = 0 },
    stop() { clearInterval(timer) }
  }
}
