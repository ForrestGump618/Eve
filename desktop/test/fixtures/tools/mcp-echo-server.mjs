#!/usr/bin/env node
// Minimal MCP stdio fixture server used by desktop/test/tools.test.ts.
// Speaks newline-delimited JSON-RPC 2.0 exactly like the bundled MCP server:
// initialize -> tools/list -> tools/call.
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2025-03-26';
const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the arguments back as JSON',
    inputSchema: { type: 'object', properties: { value: {} } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_note',
    description: 'Pretend to mutate state',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', line => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (!request || typeof request !== 'object') return;
  const { id, method, params } = request;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'suwen-fixture-mcp', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ tool: params?.name ?? null, args: params?.arguments ?? null }),
          },
        ],
      },
    });
    return;
  }
  // Notifications (notifications/initialized) carry no id and need no response.
  if (id === undefined) return;
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
});
