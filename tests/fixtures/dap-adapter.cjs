const mode = process.argv[2]
let input = Buffer.alloc(0),
  sequence = 0,
  reverse
function send(value) {
  const body = Buffer.from(JSON.stringify(value)),
    header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(header.subarray(0, 8))
  process.stdout.write(header.subarray(8))
  process.stdout.write(body)
}
function event(name, body = {}) {
  send({ seq: ++sequence, type: 'event', event: name, body })
}
process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk])
  while (true) {
    const at = input.indexOf('\r\n\r\n')
    if (at < 0) return
    const length = Number(/Content-Length:\s*(\d+)/i.exec(input.subarray(0, at).toString())[1])
    if (input.length < at + 4 + length) return
    const request = JSON.parse(input.subarray(at + 4, at + 4 + length))
    input = input.subarray(at + 4 + length)
    if (request.type === 'response' && reverse) {
      send({
        seq: ++sequence,
        type: 'response',
        request_seq: reverse.seq,
        command: reverse.command,
        success: true,
        body: { denied: request.success === false }
      })
      reverse = null
      continue
    }
    if (request.type !== 'request') continue
    if (mode === 'silent') continue
    if (mode === 'malformed') {
      process.stdout.write('Content-Length: 90000000\r\n\r\n')
      continue
    }
    if (request.command === 'reverseProbe') {
      reverse = request
      send({
        seq: 9000,
        type: 'request',
        command: 'runInTerminal',
        arguments: { args: ['must-not-execute'] }
      })
      continue
    }
    const responses = {
      initialize: {
        supportsConfigurationDoneRequest: true,
        exceptionBreakpointFilters: [{ filter: 'uncaught', label: 'Uncaught' }]
      },
      stackTrace: {
        stackFrames: [{ id: 1, name: 'fixtureFrame', source: { path: __filename }, line: 1 }]
      },
      scopes: { scopes: [{ name: 'Local', variablesReference: 1 }] },
      variables: { variables: [{ name: 'fixture', value: '42' }] },
      evaluate: { result: 'fixture-result' }
    }
    send({
      seq: ++sequence,
      type: 'response',
      request_seq: request.seq,
      command: request.command,
      success: true,
      body: responses[request.command] ?? {}
    })
    if (request.command === 'initialize') event('initialized')
    if (request.command === 'launch' || request.command === 'attach')
      event('stopped', { threadId: 1, reason: 'entry' })
    if (request.command === 'continue') event('continued')
    if (request.command === 'disconnect') setTimeout(() => process.exit(0), 20)
  }
})
