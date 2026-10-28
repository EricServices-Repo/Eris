let input = Buffer.alloc(0)
function send(value) {
  const body = Buffer.from(JSON.stringify(value))
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}
process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk])
  while (true) {
    const at = input.indexOf('\r\n\r\n')
    if (at < 0) return
    const length = Number(/Content-Length:\s*(\d+)/i.exec(input.subarray(0, at).toString())[1])
    if (input.length < at + 4 + length) return
    const msg = JSON.parse(input.subarray(at + 4, at + 4 + length))
    input = input.subarray(at + 4 + length)
    if (msg.method === 'exit') process.exit(0)
    if (msg.id !== undefined)
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result:
          msg.method === 'initialize'
            ? {
                capabilities: {
                  hoverProvider: false,
                  renameProvider: false,
                  documentFormattingProvider: true
                }
              }
            : msg.method === 'textDocument/formatting'
              ? []
              : null
      })
  }
})
