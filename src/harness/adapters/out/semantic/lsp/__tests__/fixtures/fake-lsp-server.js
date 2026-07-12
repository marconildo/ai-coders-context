'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const { once } = require('events');

const mode = process.argv[2] || 'normal';
const pidFile = process.argv[3];
const attackSize = Number(process.argv[4]) || 4096;
if (pidFile) fs.appendFileSync(pidFile, `${process.pid}\n`);

if (mode.startsWith('ignore-shutdown') || mode === 'signal-ignoring-descendant') {
  process.on('SIGTERM', () => {});
}

if (mode === 'ignore-shutdown-with-descendant') {
  spawn(process.execPath, [__filename, 'signal-ignoring-descendant', pidFile], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

let input = Buffer.alloc(0);

function send(message) {
  const content = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`);
}

async function sendFragmented(message, chunkSize = 1024) {
  const content = JSON.stringify(message);
  const frame = Buffer.from(
    `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`
  );
  for (let offset = 0; offset < frame.length; offset += chunkSize) {
    const chunk = frame.subarray(offset, Math.min(offset + chunkSize, frame.length));
    if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
    // Keep writes observably fragmented instead of filling the pipe in one turn.
    if (offset > 0 && offset % (chunkSize * 64) === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

function respond(message) {
  if (message.method === 'initialize') {
    if (mode === 'incomplete-huge-header') {
      process.stdout.write('X'.repeat(attackSize));
    } else if (mode === 'incomplete-huge-body') {
      process.stdout.write(
        `Content-Length: ${attackSize * 2}\r\n\r\n${'X'.repeat(attackSize)}`
      );
    } else if (mode === 'abusive-content-length') {
      process.stdout.write('Content-Length: 999999999999999999999999\r\n\r\n');
    } else if (mode === 'crash-after-spawn') {
      process.exit(19);
    } else if (mode === 'reject-initialize') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'initialize rejected' } });
    } else if (mode === 'fragmented-large-initialize') {
      void sendFragmented({
        jsonrpc: '2.0',
        id: message.id,
        result: { capabilities: {}, padding: 'x'.repeat(attackSize) },
      });
    } else if (mode !== 'timeout-initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
    }
    return;
  }

  if (message.method === 'shutdown') {
    if (!mode.startsWith('ignore-shutdown')) {
      send({ jsonrpc: '2.0', id: message.id, result: null });
    }
    return;
  }

  if (message.method === 'exit') {
    if (!mode.startsWith('ignore-shutdown')) process.exit(0);
    return;
  }

  if (message.method === 'textDocument/hover') {
    if (mode === 'crash-on-hover') process.exit(23);
    send({ jsonrpc: '2.0', id: message.id, result: { contents: '```ts\nFakeType\n```' } });
    return;
  }

  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: [] });
}

process.stdin.on('data', (data) => {
  input = Buffer.concat([input, data]);
  while (true) {
    const headerEnd = input.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = input.subarray(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (input.length < bodyStart + length) return;
    const message = JSON.parse(input.subarray(bodyStart, bodyStart + length).toString('utf8'));
    input = input.subarray(bodyStart + length);
    respond(message);
  }
});

// Keep the fixture alive after stdin closes so tests prove signal escalation.
setInterval(() => {}, 1000);
