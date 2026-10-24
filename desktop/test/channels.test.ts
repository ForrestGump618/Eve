import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/harness/store.js';
import type { Json } from '../src/harness/types.js';
import {
  CHANNEL_ADAPTERS, ChannelService, MAX_INBOUND_TEXT, buildMime, createSmtpTransport,
  type FetchLike, type SmtpTransport,
} from '../src/domain/channels.js';

const FIXED_NOW = 1_700_000_000_000;
const clock = (): number => FIXED_NOW;

// ---------------------------------------------------------------------------
// Fake fetch: records every request, returns scripted JSON replies.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Json;
}

interface FetchReply {
  status?: number;
  body?: Json;
  text?: string;
}

type FetchScript = FetchReply | FetchReply[] | ((request: CapturedRequest) => FetchReply | Promise<FetchReply>);

function createFetch(script: FetchScript = {}): { fetch: FetchLike; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const queue: FetchReply[] | null = typeof script === 'function' ? null : Array.isArray(script) ? [...script] : [script];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) {
      for (const [name, value] of Object.entries(rawHeaders)) headers[name.toLowerCase()] = String(value);
    }
    let body: Json = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Json;
      } catch {
        body = init.body;
      }
    }
    const request: CapturedRequest = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, body };
    requests.push(request);
    const reply = queue !== null
      ? queue.shift() ?? {}
      : await (script as (request: CapturedRequest) => FetchReply | Promise<FetchReply>)(request);
    const status = reply.status ?? 200;
    if (status === 204 || status === 205 || status === 304) return new Response(null, { status });
    const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fetchImpl, requests };
}

interface ChannelHarness {
  store: Store;
  service: ChannelService;
  dir: string;
}

function createChannelHarness(
  t: { after: (callback: () => void) => void },
  options: { fetch?: FetchLike; secrets?: Record<string, string>; smtpTransport?: SmtpTransport; timeoutMs?: number; inboxCap?: number } = {},
): ChannelHarness {
  const store = new Store(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'suwen-channels-'));
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });
  const fetchImpl = options.fetch ?? createFetch().fetch;
  const service = new ChannelService({
    store,
    home: dir,
    clock,
    fetch: fetchImpl,
    secrets: (ref: string) => options.secrets?.[ref],
    ...(options.smtpTransport === undefined ? {} : { smtpTransport: options.smtpTransport }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.inboxCap === undefined ? {} : { inboxCap: options.inboxCap }),
  });
  return { store, service, dir };
}

// ---------------------------------------------------------------------------
// Adapter contract surface
// ---------------------------------------------------------------------------

test('CHANNEL_ADAPTERS exposes the six contract adapters', () => {
  assert.deepEqual(Object.keys(CHANNEL_ADAPTERS).sort(), ['discord', 'email', 'slack', 'telegram', 'webhook', 'wechat-official']);
  for (const adapter of Object.values(CHANNEL_ADAPTERS)) {
    assert.equal(typeof adapter.validate, 'function');
    assert.equal(typeof adapter.send, 'function');
    assert.equal(typeof adapter.receive, 'function');
    assert.equal(typeof adapter.health, 'function');
    assert.equal(adapter.capabilities.inbound, true);
    assert.equal(adapter.capabilities.outbound, true);
    assert.ok(adapter.capabilities.maxText > 0);
  }
});

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

test('telegram send posts to the Bot API with the resolved secret and persists no secret', async t => {
  const fake = createFetch({ status: 200, body: { ok: true, result: { message_id: 7 } } });
  const secret = '123456:SECRET-TOKEN';
  const { service, store } = createChannelHarness(t, { fetch: fake.fetch, secrets: { 'tg.bot': secret } });
  const view = await service.save({
    type: 'telegram', name: 'tg', readOnly: false,
    config: { botRef: 'tg.bot', chatId: '42', baseUrl: 'http://127.0.0.1:8081' },
  });
  const sent = await service.send(view.id, { text: 'hello' });
  assert.equal(sent.ok, true);
  assert.equal(sent.messageId, '7');
  assert.equal(fake.requests.length, 1);
  const request = fake.requests[0];
  assert.equal(request.url, `http://127.0.0.1:8081/bot${secret}/sendMessage`);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(request.body, { chat_id: '42', text: 'hello' });
  assert.doesNotMatch(JSON.stringify(store.listRecords('channel', { limit: 500 })), /SECRET-TOKEN/);
  assert.match(JSON.stringify(view.config), /tg\.bot/);
  const inbox = service.inbox({ channelId: view.id });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].direction, 'outbound');
  assert.equal(inbox[0].text, 'hello');
  assert.ok(service.auditLog({ channelId: view.id }).some(entry => entry.action === 'send'));
});

test('channel save rejects raw secret material and read-only channels cannot send', async t => {
  const { service } = createChannelHarness(t);
  await assert.rejects(
    service.save({ type: 'telegram', name: 'bad', config: { botRef: 'tg.bot', chatId: '1', botToken: 'raw-token-value' } }),
    /secret material/,
  );
  await assert.rejects(service.save({ type: 'nope', name: 'bad', config: {} }), /type/i);
  const view = await service.save({ type: 'telegram', name: 'safe', config: { botRef: 'tg.bot', chatId: '1' } });
  assert.equal(view.readOnly, true);
  assert.equal(view.enabled, true);
  await assert.rejects(service.send(view.id, { text: 'x' }), /read-only/);
  const disabled = await service.save({ type: 'telegram', name: 'off', enabled: false, readOnly: false, config: { botRef: 'tg.bot', chatId: '1' } });
  await assert.rejects(service.send(disabled.id, { text: 'x' }), /disabled/);
  await assert.rejects(
    service.save({ type: 'email', name: 'mail', config: { host: 'smtp.example.com', port: 99999, from: 'a@example.com', to: 'b@example.com' } }),
    /port/,
  );
  await assert.rejects(service.save({ type: 'telegram', name: '', config: { botRef: 'tg.bot', chatId: '1' } }), /name/i);
});

test('channel test records health, missing secrets and timeouts', { timeout: 10_000 }, async t => {
  const fake = createFetch({ status: 200, body: { ok: true, result: { username: 'suwen_bot' } } });
  const { service } = createChannelHarness(t, { fetch: fake.fetch, secrets: { 'tg.bot': '123:TOKEN' } });
  const view = await service.save({ type: 'telegram', name: 'tg', config: { botRef: 'tg.bot', chatId: '42', baseUrl: 'http://127.0.0.1:8081' } });
  const health = await service.test(view.id);
  assert.equal(health.status, 'ok');
  assert.match(health.detail ?? '', /suwen_bot/);
  assert.equal(service.get(view.id).health.status, 'ok');
  assert.equal(fake.requests[0].url, 'http://127.0.0.1:8081/bot123:TOKEN/getMe');

  const missingHarness = createChannelHarness(t, { fetch: fake.fetch, secrets: {} });
  const missing = await missingHarness.service.save({ type: 'telegram', name: 'missing', config: { botRef: 'absent.ref', chatId: '1' } });
  const failed = await missingHarness.service.test(missing.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.detail ?? '', /Missing secret/i);

  const hangFetch: FetchLike = () => new Promise<Response>(() => { /* never resolves */ });
  const slowHarness = createChannelHarness(t, { fetch: hangFetch, secrets: { 'tg.bot': '1:T' }, timeoutMs: 120 });
  const slow = await slowHarness.service.save({ type: 'telegram', name: 'slow', config: { botRef: 'tg.bot', chatId: '1' } });
  const timedOut = await slowHarness.service.test(slow.id);
  assert.equal(timedOut.status, 'failed');
  assert.match(timedOut.detail ?? '', /timed out/i);
});

// ---------------------------------------------------------------------------
// Slack / Discord / Webhook
// ---------------------------------------------------------------------------

test('slack send posts chat.postMessage with bearer auth', async t => {
  const fake = createFetch({ status: 200, body: { ok: true, ts: '1700000000.000100' } });
  const { service } = createChannelHarness(t, { fetch: fake.fetch, secrets: { 'slack.bot': 'xoxb-secret-value' } });
  const view = await service.save({
    type: 'slack', name: 'slack', readOnly: false,
    config: { botRef: 'slack.bot', channelId: 'C123', baseUrl: 'http://127.0.0.1:8082' },
  });
  const sent = await service.send(view.id, { text: 'hi' });
  assert.equal(sent.messageId, '1700000000.000100');
  assert.equal(fake.requests[0].url, 'http://127.0.0.1:8082/chat.postMessage');
  assert.equal(fake.requests[0].headers.authorization, 'Bearer xoxb-secret-value');
  assert.deepEqual(fake.requests[0].body, { channel: 'C123', text: 'hi' });
});

test('discord send supports webhook and bot transports', async t => {
  const webhookUrl = 'http://127.0.0.1:8083/webhooks/1/SECRET-WEBHOOK';
  const webhookFetch = createFetch({ status: 204 });
  const webhookHarness = createChannelHarness(t, { fetch: webhookFetch.fetch, secrets: { 'discord.hook': webhookUrl } });
  const hook = await webhookHarness.service.save({ type: 'discord', name: 'hook', readOnly: false, config: { webhookRef: 'discord.hook' } });
  assert.equal((await webhookHarness.service.send(hook.id, { text: 'hi' })).ok, true);
  assert.equal(webhookFetch.requests[0].url, webhookUrl);
  assert.deepEqual(webhookFetch.requests[0].body, { content: 'hi' });

  const botFetch = createFetch({ status: 200, body: { id: 'm9' } });
  const botHarness = createChannelHarness(t, { fetch: botFetch.fetch, secrets: { 'discord.bot': 'Bot-Secret' } });
  const bot = await botHarness.service.save({
    type: 'discord', name: 'bot', readOnly: false,
    config: { botRef: 'discord.bot', channelId: '9', baseUrl: 'http://127.0.0.1:8084' },
  });
  const sent = await botHarness.service.send(bot.id, { text: 'yo' });
  assert.equal(sent.messageId, 'm9');
  assert.equal(botFetch.requests[0].url, 'http://127.0.0.1:8084/channels/9/messages');
  assert.equal(botFetch.requests[0].headers.authorization, 'Bot Bot-Secret');
  assert.deepEqual(botFetch.requests[0].body, { content: 'yo' });
});

test('webhook send posts JSON with bearer auth and maps HTTP failures', async t => {
  const fake = createFetch({ status: 201, body: { id: 'evt-1' } });
  const { service } = createChannelHarness(t, { fetch: fake.fetch, secrets: { 'wh.auth': 'auth-secret' } });
  const view = await service.save({
    type: 'webhook', name: 'hook', readOnly: false,
    config: { url: 'http://127.0.0.1:8085/hook', authRef: 'wh.auth' },
  });
  const sent = await service.send(view.id, { text: 'payload' });
  assert.equal(sent.messageId, 'evt-1');
  assert.deepEqual(fake.requests[0].body, { text: 'payload' });
  assert.equal(fake.requests[0].headers.authorization, 'Bearer auth-secret');

  const failingHarness = createChannelHarness(t, { fetch: createFetch({ status: 500 }).fetch, secrets: { 'wh.auth': 'auth-secret' } });
  const failing = await failingHarness.service.save({
    type: 'webhook', name: 'bad', readOnly: false,
    config: { url: 'http://127.0.0.1:8085/hook', authRef: 'wh.auth' },
  });
  await assert.rejects(failingHarness.service.send(failing.id, { text: 'x' }), /status 500/);
});

// ---------------------------------------------------------------------------
// WeChat official
// ---------------------------------------------------------------------------

test('wechat official send acquires an access token then posts a text message', async t => {
  const fake = createFetch((request): FetchReply => request.url.includes('/cgi-bin/gettoken')
    ? { status: 200, body: { access_token: 'ACCESS-1', expires_in: 7200 } }
    : { status: 200, body: { errcode: 0, errmsg: 'ok', msgid: 'wx-msg-1' } });
  const { service } = createChannelHarness(t, { fetch: fake.fetch, secrets: { 'wc.secret': 'wecom-secret' } });
  const view = await service.save({
    type: 'wechat-official', name: 'wecom', readOnly: false,
    config: { corpId: 'corp-test', agentId: 7, credentialRef: 'wc.secret', toUser: '@all', baseUrl: 'http://127.0.0.1:8086' },
  });
  const sent = await service.send(view.id, { text: 'hello' });
  assert.equal(sent.messageId, 'wx-msg-1');
  assert.equal(fake.requests.length, 2);
  assert.match(fake.requests[0].url, /\/cgi-bin\/gettoken\?corpid=corp-test&corpsecret=wecom-secret$/);
  assert.equal(fake.requests[1].url, 'http://127.0.0.1:8086/cgi-bin/message/send?access_token=ACCESS-1');
  assert.deepEqual(fake.requests[1].body, { touser: '@all', msgtype: 'text', agentid: 7, text: { content: 'hello' } });
  await service.send(view.id, { text: 'again' });
  assert.equal(fake.requests.filter(request => request.url.includes('gettoken')).length, 1);
});

// ---------------------------------------------------------------------------
// Email: MIME + injected transport + real SMTP fixture
// ---------------------------------------------------------------------------

test('email adapter builds MIME and sends through the injected transport', async t => {
  const transportCalls: Array<{ host: string; port: number; secure: boolean; from: string; to: string[]; username?: string; credential?: string; mime: string }> = [];
  const transport: SmtpTransport = async message => { transportCalls.push(message as typeof transportCalls[number]); };
  const { service } = createChannelHarness(t, { smtpTransport: transport, secrets: { 'mail.pass': 'mail-secret' } });
  const view = await service.save({
    type: 'email', name: 'mail', readOnly: false,
    config: { host: '127.0.0.1', port: 2525, secure: false, from: 'suwen@example.com', to: ['ops@example.com'], user: 'bot', credentialRef: 'mail.pass' },
  });
  const sent = await service.send(view.id, { text: 'hello email', subject: 'Résumé ready' });
  assert.match(sent.messageId ?? '', /@suwen\.local>$/);
  assert.equal(transportCalls.length, 1);
  const message = transportCalls[0];
  assert.equal(message.host, '127.0.0.1');
  assert.equal(message.port, 2525);
  assert.equal(message.secure, false);
  assert.equal(message.from, 'suwen@example.com');
  assert.deepEqual(message.to, ['ops@example.com']);
  assert.equal(message.username, 'bot');
  assert.equal(message.credential, 'mail-secret');
  assert.match(message.mime, /Subject: =\?UTF-8\?B\?/);
  assert.match(message.mime, /Content-Transfer-Encoding: base64/);
  const bodyStart = message.mime.indexOf('\r\n\r\n') + 4;
  const body = message.mime.slice(bodyStart).replace(/\r\n/g, '');
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'hello email');

  const noSmtp = createChannelHarness(t, { secrets: {} });
  const unconfigured = await noSmtp.service.save({
    type: 'email', name: 'mail2', readOnly: false,
    config: { host: '127.0.0.1', port: 2525, from: 'a@example.com', to: 'b@example.com' },
  });
  await assert.rejects(noSmtp.service.send(unconfigured.id, { text: 'x' }), /SMTP transport unavailable/);
  const health = await noSmtp.service.test(unconfigured.id);
  assert.equal(health.status, 'failed');
  assert.match(health.detail ?? '', /transport/i);
});

test('email send performs a real SMTP AUTH LOGIN round trip against a loopback fixture', { timeout: 15_000 }, async t => {
  const transcript: string[] = [];
  const dataLines: string[] = [];
  let inData = false;
  let phase: 'ready' | 'user' | 'pass' = 'ready';
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    socket.on('error', () => { /* client resets after QUIT; fixture teardown must stay quiet */ });
    socket.write('220 fixture-smtp ESMTP\r\n');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 queued\r\n');
          } else {
            dataLines.push(line);
          }
        } else if (line.startsWith('EHLO')) {
          transcript.push(line);
          socket.write('250 fixture\r\n');
        } else if (line === 'AUTH LOGIN') {
          transcript.push(line);
          phase = 'user';
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (phase === 'user') {
          transcript.push(line);
          phase = 'pass';
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (phase === 'pass') {
          transcript.push(line);
          phase = 'ready';
          socket.write('235 Authentication successful\r\n');
        } else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) {
          transcript.push(line);
          socket.write('250 ok\r\n');
        } else if (line === 'DATA') {
          transcript.push(line);
          inData = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (line === 'QUIT') {
          transcript.push(line);
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          transcript.push(line);
          socket.write('250 ok\r\n');
        }
        index = buffer.indexOf('\r\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = (address as AddressInfo).port;

  const smtp = createSmtpTransport({ timeoutMs: 5000 });
  const { service } = createChannelHarness(t, { smtpTransport: smtp, secrets: { 'mail.pass': 'smtp-secret' } });
  const view = await service.save({
    type: 'email', name: 'smtp', readOnly: false,
    config: { host: '127.0.0.1', port, secure: false, from: 'suwen@example.com', to: ['ops@example.com', 'second@example.com'], user: 'bot', credentialRef: 'mail.pass' },
  });
  await service.send(view.id, { text: 'real smtp body', subject: 'SMTP fixture' });
  assert.ok(transcript.includes('AUTH LOGIN'));
  assert.ok(transcript.includes(Buffer.from('bot').toString('base64')));
  assert.ok(transcript.includes(Buffer.from('smtp-secret').toString('base64')));
  assert.ok(transcript.some(line => line.startsWith('MAIL FROM:<suwen@example.com>')));
  assert.ok(transcript.some(line => line.startsWith('RCPT TO:<second@example.com>')));
  assert.ok(dataLines.some(line => line.startsWith('Subject: SMTP fixture')));
  const encoded = dataLines.filter(line => /^[A-Za-z0-9+/=]+$/.test(line)).join('');
  assert.match(Buffer.from(encoded, 'base64').toString('utf8'), /real smtp body/);
});

test('buildMime produces RFC headers and a base64 utf-8 body', () => {
  const mime = buildMime({ text: 'héllo', subject: 'Résumé' }, { from: 'a@example.com', to: ['b@example.com', 'c@example.com'] }, 0);
  assert.match(mime, /^From: a@example\.com\r\nTo: b@example\.com, c@example\.com\r\n/);
  assert.match(mime, /Date: Thu, 01 Jan 1970 00:00:00 \+0000/);
  assert.match(mime, /Subject: =\?UTF-8\?B\?/);
  assert.match(mime, /X-Suwen-Channel: email/);
  const bodyStart = mime.indexOf('\r\n\r\n') + 4;
  const body = mime.slice(bodyStart).replace(/\r\n/g, '');
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'héllo');
});

// ---------------------------------------------------------------------------
// Inbound normalization, dedupe, truncation and inbox cap
// ---------------------------------------------------------------------------

test('inbound payloads normalize, dedupe and truncate at 4000 characters', async t => {
  const { service, store } = createChannelHarness(t, { inboxCap: 5 });
  const view = await service.save({ type: 'telegram', name: 'tg', config: { botRef: 'tg.bot', chatId: '42' } });
  const payload = { update_id: 1001, message: { date: 1700000000, text: 'hello inbound', from: { id: 555 }, chat: { id: 42 } } };
  const first = await service.receive(view.id, payload);
  assert.equal(first.duplicate, false);
  assert.equal(first.message.channelId, view.id);
  assert.equal(first.message.externalUserId, '555');
  assert.equal(first.message.text, 'hello inbound');
  assert.equal(first.message.at, 1700000000000);
  const duplicate = await service.receive(view.id, payload);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.recordId, first.recordId);
  assert.equal(store.countRecords('channelMessage', {}), 1);

  const hook = await service.save({ type: 'webhook', name: 'hook', config: { url: 'http://127.0.0.1:8087/hook' } });
  const long = await service.receive(hook.id, { id: 'evt-long', userId: 'u1', at: FIXED_NOW, text: 'y'.repeat(5000) });
  assert.equal(long.message.text.length, MAX_INBOUND_TEXT);
  assert.equal(long.message.text.length, 4000);
  assert.equal(long.message.externalId, 'evt-long');
  const storedLong = store.getRecord(long.recordId);
  assert.ok(storedLong);
  assert.equal((storedLong.data as unknown as Record<string, Json>).truncated, true);

  for (let index = 0; index < 8; index += 1) {
    await service.receive(hook.id, { id: `evt-${index}`, userId: 'u', at: FIXED_NOW + 1000 + index, text: `msg ${index}` });
  }
  assert.ok(store.countRecords('channelMessage', {}) <= 5);
  assert.ok(service.inbox({ channelId: hook.id }).length <= 5);

  await assert.rejects(service.receive(hook.id, { nothing: true }), /Unrecognized/);
  await assert.rejects(service.receive(hook.id, { id: 'empty', text: '   ' }), /empty/);

  const offline: FetchLike = async () => { throw new Error('ECONNREFUSED'); };
  const offlineHarness = createChannelHarness(t, { fetch: offline });
  const offlineView = await offlineHarness.service.save({ type: 'webhook', name: 'offline', config: { url: 'http://127.0.0.1:9/hook' } });
  const health = await offlineHarness.service.test(offlineView.id);
  assert.equal(health.status, 'failed');
  assert.match(health.detail ?? '', /unreachable/i);
});

// ---------------------------------------------------------------------------
// Secret isolation
// ---------------------------------------------------------------------------

test('channel errors never leak resolved secret values', async t => {
  const secret = 'super-secret-value';
  const failingFetch: FetchLike = async () => { throw new Error(`connect failed while using ${secret}`); };
  const { service } = createChannelHarness(t, { fetch: failingFetch, secrets: { 'wh.auth': secret } });
  const view = await service.save({
    type: 'webhook', name: 'hook', readOnly: false,
    config: { url: 'http://127.0.0.1:8088/hook', authRef: 'wh.auth' },
  });
  let message = '';
  try {
    await service.send(view.id, { text: 'x' });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(message.length > 0);
  assert.doesNotMatch(message, new RegExp(secret));
  assert.match(message, /\[redacted\]|failed/i);
  const health = await service.test(view.id);
  assert.equal(health.status, 'failed');
  assert.doesNotMatch(health.detail ?? '', new RegExp(secret));
});
