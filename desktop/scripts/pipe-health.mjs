// Minimal local helper: read a SuWen daemon connection file and perform one RPC.
// Used by scripts/verify-installer.ps1 to check the background daemon of an installed app.
// Usage: node scripts/pipe-health.mjs --home "<runtime dir>" [--method health] [--params '{}']
// Protocol: one line JSON {token, method, params} -> one line JSON {result}|{error}; no ids.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf('--' + name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}
const home = arg('home');
const method = arg('method', 'health');
const params = JSON.parse(arg('params', '{}'));
if (!home) {
  console.error('missing --home');
  process.exit(2);
}
let connection;
try {
  connection = JSON.parse(readFileSync(join(home, 'connection.json'), 'utf8'));
} catch (error) {
  console.error('connection_unavailable: ' + (error instanceof Error ? error.message : String(error)));
  process.exit(3);
}
if (!connection || typeof connection.pipe !== 'string' || typeof connection.token !== 'string') {
  console.error('connection_invalid');
  process.exit(3);
}
const socket = connect(connection.pipe);
const timer = setTimeout(() => {
  console.error('rpc_timeout');
  socket.destroy();
  process.exit(4);
}, 10000);
let buffer = '';
socket.setEncoding('utf8');
socket.on('connect', () => {
  socket.write(JSON.stringify({ token: connection.token, method, params }) + '\n');
});
socket.on('data', (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf('\n');
  if (newline < 0) return;
  clearTimeout(timer);
  const line = buffer.slice(0, newline).trim();
  socket.end();
  try {
    const parsed = JSON.parse(line);
    if (parsed.error) {
      console.error('rpc_error: ' + String(parsed.error));
      process.exit(5);
    }
    process.stdout.write(JSON.stringify({ method, result: parsed.result, pid: connection.pid ?? null }) + '\n');
    process.exit(0);
  } catch (error) {
    console.error('protocol_error: ' + (error instanceof Error ? error.message : String(error)) + ' raw=' + line.slice(0, 400));
    process.exit(6);
  }
});
socket.on('error', (error) => {
  clearTimeout(timer);
  console.error('socket_error: ' + error.message);
  process.exit(7);
});
