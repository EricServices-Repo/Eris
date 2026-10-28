import { DapSession } from './dap-session'
import { pathToFileURL } from 'url'
import type { LaunchConfig, DebugSessionState, Breakpoint } from './debug-service'
export class DapDebugger {
  readonly client: DapSession
  state: DebugSessionState
  private thread = 0
  private frame = 0
  private pauseGeneration = 0
  get adapter() {
    return this.config.type
  }
  private initialized: Promise<void>
  private initializedResolve!: () => void
  private initializedReject!: (e: Error) => void
  private initTimer: ReturnType<typeof setTimeout>
  constructor(
    root: string,
    command: string,
    args: string[],
    private config: LaunchConfig,
    private emit: (state: DebugSessionState) => void
  ) {
    this.state = {
      running: true,
      paused: false,
      configId: config.id,
      program: config.program,
      port: null,
      output: '[DAP stdio adapter starting]\n'
    }
    this.initialized = new Promise((resolve, reject) => {
      this.initializedResolve = resolve
      this.initializedReject = reject
    })
    // Install rejection handling before initialize/launch can fail; start still observes the rejection.
    void this.initialized.catch(() => {})
    this.initTimer = setTimeout(() => {
      this.initializedReject(new Error('DAP initialized event timed out'))
      void this.stop()
    }, 10000)
    this.client = new DapSession(
      root,
      command,
      args,
      (event, body) => this.event(event, body),
      (reason) => {
        clearTimeout(this.initTimer)
        this.initializedReject(new Error(reason))
        this.state = { ...this.state, running: false, paused: false, reason }
        this.emit(this.state)
      }
    )
  }
  async start(root: string, program: string, bps: Breakpoint[]) {
    try {
      this.client.capabilities = await this.client.request('initialize', {
        adapterID: this.config.type,
        clientID: 'eris',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsRunInTerminalRequest: false,
        supportsStartDebuggingRequest: false
      })
      const launch = this.client.request(
        this.config.request,
        this.config.request === 'attach'
          ? { port: this.config.port, host: '127.0.0.1' }
          : {
              program,
              args: this.config.args ?? [],
              cwd: this.config.cwd ?? root,
              env: this.config.env ?? {},
              stopOnEntry: true
            }
      )
      void launch.catch(() => {})
      await this.initialized
      clearTimeout(this.initTimer)
      const paths = [...new Set(bps.map((b) => b.path))]
      for (const path of paths)
        await this.client.request('setBreakpoints', {
          source: { path },
          breakpoints: bps
            .filter((b) => b.path === path && b.enabled)
            .map((b) => ({ line: b.line }))
        })
      if (this.client.capabilities.supportsConfigurationDoneRequest === true)
        await this.client.request('configurationDone')
      await launch
      this.emit(this.state)
      return this.state
    } catch (e) {
      await this.stop()
      throw e
    }
  }
  private event(event: string, body: Record<string, unknown>) {
    if (event === 'initialized') this.initializedResolve()
    if (event === 'output') {
      this.state.output = (this.state.output + String(body.output ?? '').slice(0, 20000)).slice(
        -200000
      )
      this.emit(this.state)
    }
    if (event === 'stopped') {
      const generation = ++this.pauseGeneration
      this.thread = Number(body.threadId) || 0
      this.state.paused = true
      this.state.reason = String(body.reason ?? 'paused').slice(0, 256)
      this.emit(this.state)
      void this.client
        .request('stackTrace', { threadId: this.thread, levels: 20 })
        .then((result) => {
          if (!this.state.paused || generation !== this.pauseGeneration) return
          const frames = Array.isArray(result.stackFrames)
            ? (result.stackFrames as Array<{
                id: number
                name: string
                source?: { path?: string }
                line: number
              }>)
            : []
          this.frame = frames[0]?.id ?? 0
          this.state.callFrames = frames.slice(0, 20).map((f) => ({
            functionName: String(f.name).slice(0, 256),
            url: f.source?.path ? pathToFileURL(f.source.path).href : '',
            lineNumber: f.line
          }))
          this.emit(this.state)
        })
        .catch(() => {})
    }
    if (event === 'continued') {
      this.pauseGeneration++
      this.state.paused = false
      this.state.callFrames = []
      this.frame = 0
      this.emit(this.state)
    }
    if (event === 'terminated' || event === 'exited') {
      this.state.running = false
      this.state.paused = false
      this.emit(this.state)
      void this.stop()
    }
  }
  async command(command: 'continue' | 'next' | 'stepIn' | 'stepOut') {
    if (!this.state.paused) throw new Error('Debugger is not paused')
    await this.client.request(command, { threadId: this.thread })
  }
  async variables() {
    if (!this.state.paused || !this.frame)
      throw new Error('Pause in a stack frame to inspect variables')
    const generation = this.pauseGeneration
    const scopes = await this.client.request('scopes', { frameId: this.frame })
    const result: Array<{ name: string; value: string }> = []
    for (const scope of (Array.isArray(scopes.scopes) ? scopes.scopes : []).slice(0, 4) as Array<{
      variablesReference: number
    }>) {
      const response = await this.client.request('variables', {
        variablesReference: scope.variablesReference,
        start: 0,
        count: 100
      })
      for (const variable of (Array.isArray(response.variables) ? response.variables : []).slice(
        0,
        100
      ) as Array<{ name: unknown; value: unknown }>)
        result.push({
          name: String(variable.name).slice(0, 256),
          value: String(variable.value).slice(0, 2000)
        })
    }
    if (generation !== this.pauseGeneration || !this.state.paused)
      throw new Error('Stale debugger variables')
    return result
  }
  async evaluate(expression: string) {
    if (!this.state.paused) throw new Error('Pause before evaluating a watch')
    const generation = this.pauseGeneration
    const result = await this.client.request('evaluate', {
      expression,
      context: 'watch',
      frameId: this.frame
    })
    if (generation !== this.pauseGeneration || !this.state.paused)
      throw new Error('Stale debugger evaluation')
    return result
  }
  async exceptions(filters: string[]) {
    const supported = Array.isArray(this.client.capabilities.exceptionBreakpointFilters)
      ? (this.client.capabilities.exceptionBreakpointFilters as Array<{ filter: string }>)
      : []
    if (filters.some((f) => !supported.some((s) => s.filter === f)))
      throw new Error('Exception filter was not advertised by adapter')
    await this.client.request('setExceptionBreakpoints', { filters })
  }
  async stop() {
    clearTimeout(this.initTimer)
    await this.client.stop(this.config.request === 'launch')
  }
}
