#!/usr/bin/env node
/**
 * Minimal deterministic stdio MCP fixture used by scripts/e2e-research.mjs.
 *
 * Implements exactly the JSON-RPC surface the daemon MCP client needs:
 *   initialize -> protocolVersion 2025-03-26 / capabilities.tools / serverInfo.name
 *   notifications/initialized (ignored; notifications carry no id)
 *   tools/list -> one read-only tool
 *   tools/call -> one text content entry whose text is JSON
 *
 * It never touches the network and never reads files.
 */
import { createInterface } from 'node:readline';

const PROTOCOL = '2025-03-26';
const SERVER_NAME = 'suwen-e2e-fixture-mcp';
const TOOL = {
  name: 'e2e_ping',
  description: 'Deterministic fixture tool used by the research end-to-end harness.',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string', description: 'Optional echo payload.' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n', () => {});
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  const text = String(line ?? '').trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return; // ignore malformed frames, the client will time out
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  // Notifications (no id) are one-way; never answer them.
  if (message.id === undefined || message.id === null) return;

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [TOOL] } });
    return;
  }
  if (message.method === 'tools/call') {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    if (params.name !== TOOL.name) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } });
      return;
    }
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, echo: typeof args.message === 'string' ? args.message : '' }) }] },
    });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
