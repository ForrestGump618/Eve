import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { createHash } from 'node:crypto';
import { ValidationError, type Json } from '../harness/types.js';
import type { ChannelView, RecordRow, RecordStore } from '../shared/contract.js';
import { safeError } from '../security.js';

/** Minimal injectable fetch surface; adapters never assume a network in tests. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
/** Secret references are resolved only at call time; values never enter persisted config or errors. */
export type SecretResolver = (ref: string) => string | undefined | Promise<string | undefined>;

export const CHANNEL_TYPES = ['telegram', 'slack', 'discord', 'email', 'webhook', 'wechat-official'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const MAX_INBOUND_TEXT = 4000;

export interface ChannelCapabilities { inbound: boolean; outbound: boolean; attachments: boolean; maxText: number }
export interface OutboundMessage { text: string; to?: string; subject?: string }
export interface InboundMessage { channelId: string; externalUserId: string; text: string; at: number; externalId?: string }
export interface SmtpMessage {
  host: string; port: number; secure: boolean; from: string; to: string[];
  username?: string; credential?: string; mime: string;
}
export type SmtpTransport = (message: SmtpMessage, signal?: AbortSignal) => Promise<void>;

export interface ChannelCallContext {
  secrets?: Record<string, string>;
  transport?: SmtpTransport;
  signal?: AbortSignal;
  now?: number;
}

export interface ChannelHealth { status: 'ok' | 'failed'; detail?: string }

export interface ChannelAdapter {
  id: ChannelType;
  capabilities: ChannelCapabilities;
  validate(config: Json): void;
  /** Names of config properties that hold secret references, resolved only at call time. */
  secretRefs(config: Json): string[];
  health(config: Json, fetchImpl: FetchLike, context?: ChannelCallContext): Promise<ChannelHealth>;
  send(message: OutboundMessage, config: Json, fetchImpl: FetchLike, context?: ChannelCallContext): Promise<{ messageId?: string; at: number }>;
  receive(payload: Json): InboundMessage | null;
  connect?(config: Json, fetchImpl: FetchLike, context?: ChannelCallContext): Promise<void>;
  disconnect?(): Promise<void>;
  auth?(config: Json, fetchImpl: FetchLike, context?: ChannelCallContext): Promise<{ ok: boolean }>;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const REF_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,159}$/;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function text(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || CONTROL.test(value)) {
    throw new ValidationError(`${name} must be a string of ${min}..${max} printable characters`);
  }
  return value;
}

function optText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, name, 1, max);
}

function configObject(config: Json): Record<string, Json> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ValidationError('config must be an object');
  return config as Record<string, Json>;
}

function refName(value: unknown, name: string): string {
  const ref = text(value, name, 1, 160);
  if (!REF_NAME.test(ref)) throw new ValidationError(`${name} must be a secret reference name, not a secret value`);
  return ref;
}

function httpUrl(value: unknown, name: string): string {
  const raw = text(value, name, 8, 2000);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new ValidationError(`${name} must be a valid http(s) URL`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ValidationError(`${name} must use http or https`);
  if (parsed.username || parsed.password) throw new ValidationError(`${name} must not embed credentials; use a secret reference`);
  return raw;
}

function baseUrl(config: Record<string, Json>, fallback: string): string {
  const raw = optText(config.baseUrl, 'baseUrl', 2000);
  const value = raw === undefined ? fallback : httpUrl(raw, 'baseUrl');
  return value.replace(/\/+$/, '');
}

function boolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ValidationError(`${name} must be a boolean`);
  return value;
}

function emailAddress(value: unknown, name: string): string {
  const raw = text(value, name, 3, 320);
  if (!EMAIL.test(raw)) throw new ValidationError(`${name} must be a valid email address`);
  return raw;
}

/** Reject raw secret material in persisted config; only secret references are allowed. */
export function assertNoSecretMaterial(config: Json): void {
  const visit = (value: Json, path: string): void => {
    if (Array.isArray(value)) { value.forEach((entry, index) => visit(entry, `${path}[${index}]`)); return; }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (/token|secret|password|authorization|api.?key/i.test(key)) {
          throw new ValidationError(`config key ${path === '' ? key : `${path}.${key}`} looks like secret material; persist a secret reference field (botRef, credentialRef, authRef) instead`);
        }
        visit(child as Json, path === '' ? key : `${path}.${key}`);
      }
      return;
    }
    if (typeof value === 'string' && /^(?:Bearer\s+|Basic\s+|sk-[A-Za-z0-9]|xox[abposr]-)/.test(value)) {
      throw new ValidationError(`config value at ${path || 'config'} looks like raw secret material; persist a secret reference instead`);
    }
  };
  visit(config, '');
}

function secretOf(context: ChannelCallContext | undefined, ref: string): string {
  const value = context?.secrets?.[ref];
  if (typeof value !== 'string' || !value.length) throw new Error(`Missing secret value for reference ${ref}`);
  return value;
}

async function requestJson(fetchImpl: FetchLike, url: string, init: RequestInit, context?: ChannelCallContext): Promise<{ status: number; body: any }> {
  const response = await fetchImpl(url, { ...init, ...(context?.signal ? { signal: context.signal } : {}) });
  const raw = await response.text();
  let body: any = null;
  if (raw.trim()) { try { body = JSON.parse(raw); } catch { body = null; } }
  return { status: response.status, body };
}

function jsonBody(init: RequestInit, body: unknown): RequestInit {
  return {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    body: JSON.stringify(body),
  };
}

function bearer(token: string): Record<string, string> { return { authorization: `Bearer ${token}` }; }

function inbound(externalUserId: string, textValue: string, at: number, externalId?: string): InboundMessage {
  return { channelId: '', externalUserId, text: textValue, at, ...(externalId === undefined ? {} : { externalId }) };
}

// ---------------------------------------------------------------------------
// Telegram Bot API
// ---------------------------------------------------------------------------

const telegram: ChannelAdapter = {
  id: 'telegram',
  capabilities: { inbound: true, outbound: true, attachments: false, maxText: 4096 },
  validate(config) {
    const value = configObject(config);
    refName(value.botRef, 'botRef');
    text(value.chatId, 'chatId', 1, 64);
    if (value.baseUrl !== undefined) httpUrl(value.baseUrl, 'baseUrl');
    if (value.parseMode !== undefined) text(value.parseMode, 'parseMode', 1, 32);
  },
  secretRefs(config) { return [refName(configObject(config).botRef, 'botRef')]; },
  async health(config, fetchImpl, context) {
    const value = configObject(config);
    const token = secretOf(context, String(value.botRef));
    const url = `${baseUrl(value, 'https://api.telegram.org')}/bot${token}/getMe`;
    const { status, body } = await requestJson(fetchImpl, url, { method: 'GET' }, context);
    if (status !== 200 || body?.ok !== true) return { status: 'failed', detail: `Telegram getMe failed with status ${status}` };
    return { status: 'ok', detail: typeof body?.result?.username === 'string' ? `bot @${body.result.username}` : 'telegram reachable' };
  },
  async send(message, config, fetchImpl, context) {
    const value = configObject(config);
    const token = secretOf(context, String(value.botRef));
    const url = `${baseUrl(value, 'https://api.telegram.org')}/bot${token}/sendMessage`;
    const body: Record<string, Json> = { chat_id: String(value.chatId), text: message.text };
    if (typeof value.parseMode === 'string') body.parse_mode = value.parseMode;
    const response = await requestJson(fetchImpl, url, jsonBody({ method: 'POST' }, body), context);
    if (response.status !== 200 || response.body?.ok !== true) throw new Error(`Telegram sendMessage failed with status ${response.status}`);
    const messageId = response.body?.result?.message_id;
    return { at: context?.now ?? Date.now(), ...(typeof messageId === 'number' ? { messageId: String(messageId) } : {}) };
  },
  receive(payload) {
    const value = configObject(payload);
    const update = value.message && typeof value.message === 'object' ? value.message as Record<string, Json> : value;
    const chat = update.chat && typeof update.chat === 'object' ? update.chat as Record<string, Json> : {};
    const from = update.from && typeof update.from === 'object' ? update.from as Record<string, Json> : {};
    if (typeof update.text !== 'string') return null;
    const at = typeof update.date === 'number' ? update.date * 1000 : 0;
    const externalId = value.update_id !== undefined ? String(value.update_id) : undefined;
    return inbound(String(from.id ?? from.username ?? chat.id ?? 'unknown'), update.text, at, externalId);
  },
};

// ---------------------------------------------------------------------------
// Slack Web API
// ---------------------------------------------------------------------------

const slack: ChannelAdapter = {
  id: 'slack',
  capabilities: { inbound: true, outbound: true, attachments: false, maxText: 39000 },
  validate(config) {
    const value = configObject(config);
    refName(value.botRef, 'botRef');
    text(value.channelId, 'channelId', 1, 64);
    if (value.baseUrl !== undefined) httpUrl(value.baseUrl, 'baseUrl');
  },
  secretRefs(config) { return [refName(configObject(config).botRef, 'botRef')]; },
  async health(config, fetchImpl, context) {
    const value = configObject(config);
    const token = secretOf(context, String(value.botRef));
    const { status, body } = await requestJson(fetchImpl, `${baseUrl(value, 'https://slack.com/api')}/auth.test`, jsonBody({ method: 'POST', headers: bearer(token) }, {}), context);
    if (status !== 200 || body?.ok !== true) return { status: 'failed', detail: `Slack auth.test failed with status ${status}` };
    return { status: 'ok', detail: typeof body?.team === 'string' ? `workspace ${body.team}` : 'slack reachable' };
  },
  async send(message, config, fetchImpl, context) {
    const value = configObject(config);
    const token = secretOf(context, String(value.botRef));
    const response = await requestJson(fetchImpl, `${baseUrl(value, 'https://slack.com/api')}/chat.postMessage`, jsonBody({ method: 'POST', headers: bearer(token) }, { channel: String(value.channelId), text: message.text }), context);
    if (response.status !== 200 || response.body?.ok !== true) {
      const error = typeof response.body?.error === 'string' ? response.body.error : `status ${response.status}`;
      throw new Error(`Slack chat.postMessage failed: ${error}`);
    }
    return { at: context?.now ?? Date.now(), ...(typeof response.body?.ts === 'string' ? { messageId: response.body.ts } : {}) };
  },
  receive(payload) {
    const value = configObject(payload);
    const event = value.event && typeof value.event === 'object' ? value.event as Record<string, Json> : value;
    if (typeof event.text !== 'string') return null;
    const at = typeof event.ts === 'string' && Number.isFinite(Number(event.ts)) ? Math.round(Number(event.ts) * 1000) : 0;
    const externalId = typeof value.event_id === 'string' ? value.event_id : typeof event.client_msg_id === 'string' ? String(event.client_msg_id) : undefined;
    return inbound(String(event.user ?? event.bot_id ?? 'unknown'), event.text, at, externalId);
  },
};

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

const discord: ChannelAdapter = {
  id: 'discord',
  capabilities: { inbound: true, outbound: true, attachments: false, maxText: 2000 },
  validate(config) {
    const value = configObject(config);
    const webhookRef = optText(value.webhookRef, 'webhookRef', 160);
    const botRef = optText(value.botRef, 'botRef', 160);
    if (webhookRef === undefined && botRef === undefined) throw new ValidationError('discord config requires webhookRef or botRef');
    if (webhookRef !== undefined) refName(webhookRef, 'webhookRef');
    if (botRef !== undefined) refName(botRef, 'botRef');
    if (botRef !== undefined) text(value.channelId, 'channelId', 1, 64);
    if (value.baseUrl !== undefined) httpUrl(value.baseUrl, 'baseUrl');
  },
  secretRefs(config) {
    const value = configObject(config);
    const refs: string[] = [];
    if (typeof value.webhookRef === 'string') refs.push(refName(value.webhookRef, 'webhookRef'));
    if (typeof value.botRef === 'string') refs.push(refName(value.botRef, 'botRef'));
    return refs;
  },
  async health(config, fetchImpl, context) {
    const value = configObject(config);
    const base = baseUrl(value, 'https://discord.com/api/v10');
    const url = typeof value.webhookRef === 'string'
      ? secretOf(context, value.webhookRef)
      : `${base}/users/@me`;
    const init = typeof value.botRef === 'string'
      ? { method: 'GET', headers: { authorization: `Bot ${secretOf(context, value.botRef)}` } }
      : { method: 'GET' };
    const { status } = await requestJson(fetchImpl, url, init, context);
    return status >= 200 && status < 300 ? { status: 'ok', detail: 'discord reachable' } : { status: 'failed', detail: `Discord request failed with status ${status}` };
  },
  async send(message, config, fetchImpl, context) {
    const value = configObject(config);
    if (typeof value.webhookRef === 'string') {
      const url = secretOf(context, value.webhookRef);
      const response = await requestJson(fetchImpl, url, jsonBody({ method: 'POST' }, { content: message.text }), context);
      if (response.status < 200 || response.status >= 300) throw new Error(`Discord webhook failed with status ${response.status}`);
      return { at: context?.now ?? Date.now() };
    }
    const token = secretOf(context, String(value.botRef));
    const url = `${baseUrl(value, 'https://discord.com/api/v10')}/channels/${String(value.channelId)}/messages`;
    const response = await requestJson(fetchImpl, url, jsonBody({ method: 'POST', headers: { authorization: `Bot ${token}` } }, { content: message.text }), context);
    if (response.status < 200 || response.status >= 300) throw new Error(`Discord channel message failed with status ${response.status}`);
    return { at: context?.now ?? Date.now(), ...(typeof response.body?.id === 'string' ? { messageId: response.body.id } : {}) };
  },
  receive(payload) {
    const value = configObject(payload);
    if (typeof value.content !== 'string') return null;
    const author = value.author && typeof value.author === 'object' ? value.author as Record<string, Json> : {};
    const at = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) || 0 : 0;
    const externalId = typeof value.id === 'string' ? value.id : undefined;
    return inbound(String(author.id ?? author.username ?? 'unknown'), value.content, at, externalId);
  },
};

// ---------------------------------------------------------------------------
// Generic webhook
// ---------------------------------------------------------------------------

const webhook: ChannelAdapter = {
  id: 'webhook',
  capabilities: { inbound: true, outbound: true, attachments: false, maxText: 4000 },
  validate(config) {
    const value = configObject(config);
    httpUrl(value.url, 'url');
    if (value.authRef !== undefined) refName(value.authRef, 'authRef');
  },
  secretRefs(config) {
    const value = configObject(config);
    return typeof value.authRef === 'string' ? [refName(value.authRef, 'authRef')] : [];
  },
  async health(config, fetchImpl, context) {
    const value = configObject(config);
    try {
      const { status } = await requestJson(fetchImpl, httpUrl(value.url, 'url'), { method: 'GET', headers: { accept: 'application/json' } }, context);
      return { status: 'ok', detail: `webhook reachable (status ${status})` };
    } catch (error) {
      return { status: 'failed', detail: `webhook unreachable: ${safeError(error)}` };
    }
  },
  async send(message, config, fetchImpl, context) {
    const value = configObject(config);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (typeof value.authRef === 'string') headers.authorization = `Bearer ${secretOf(context, value.authRef)}`;
    const response = await requestJson(fetchImpl, httpUrl(value.url, 'url'), jsonBody({ method: 'POST', headers }, { text: message.text }), context);
    if (response.status < 200 || response.status >= 300) throw new Error(`Webhook POST failed with status ${response.status}`);
    return { at: context?.now ?? Date.now(), ...(typeof response.body?.id === 'string' ? { messageId: response.body.id } : {}) };
  },
  receive(payload) {
    const value = configObject(payload);
    if (typeof value.text !== 'string') return null;
    const at = typeof value.at === 'number' ? value.at : 0;
    const externalId = typeof value.id === 'string' ? value.id : undefined;
    return inbound(String(value.userId ?? value.user ?? 'webhook'), value.text, at, externalId);
  },
};

// ---------------------------------------------------------------------------
// Email (MIME builder + injected SMTP transport)
// ---------------------------------------------------------------------------

function base64Lines(value: Buffer): string {
  const encoded = value.toString('base64');
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) lines.push(encoded.slice(index, index + 76));
  return lines.join('\r\n');
}

function encodedHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value) && !/^=\?/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function rfc2822(at: number): string {
  const date = new Date(at);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/** Build a minimal UTF-8 MIME message for the injected SMTP transport. */
export function buildMime(message: OutboundMessage, config: Json, at: number): string {
  const value = configObject(config);
  const from = emailAddress(value.from, 'from');
  const recipients = Array.isArray(value.to) ? value.to.map((entry, index) => emailAddress(entry, `to[${index}]`)) : [emailAddress(value.to, 'to')];
  const subject = typeof message.subject === 'string' && message.subject.trim() ? message.subject.trim() : 'SuWen message';
  const headers = [
    `From: ${from}`,
    `To: ${recipients.join(', ')}`,
    `Subject: ${encodedHeader(subject.replace(/[\r\n]+/g, ' ').slice(0, 200))}`,
    `Date: ${rfc2822(at)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'X-Suwen-Channel: email',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${base64Lines(Buffer.from(message.text, 'utf8'))}\r\n`;
}

const email: ChannelAdapter = {
  id: 'email',
  capabilities: { inbound: true, outbound: true, attachments: false, maxText: 100_000 },
  validate(config) {
    const value = configObject(config);
    text(value.host, 'host', 1, 253);
    if (typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new ValidationError('port must be an integer 1..65535');
    emailAddress(value.from, 'from');
    if (Array.isArray(value.to)) {
      if (value.to.length < 1 || value.to.length > 10) throw new ValidationError('to must list 1..10 recipients');
      value.to.forEach((entry, index) => emailAddress(entry, `to[${index}]`));
    } else emailAddress(value.to, 'to');
    if (value.user !== undefined) text(value.user, 'user', 1, 320);
    if (value.credentialRef !== undefined) refName(value.credentialRef, 'credentialRef');
    if (value.secure !== undefined) boolean(value.secure, 'secure', false);
  },
  secretRefs(config) {
    const value = configObject(config);
    return typeof value.credentialRef === 'string' ? [refName(value.credentialRef, 'credentialRef')] : [];
  },
  async health(config, _fetchImpl, context) {
    try {
      configObject(config);
      email.validate(config);
    } catch (error) { return { status: 'failed', detail: safeError(error) }; }
    return context?.transport ? { status: 'ok', detail: 'smtp transport configured' } : { status: 'failed', detail: 'smtp transport unavailable' };
  },
  async send(message, config, _fetchImpl, context) {
    const value = configObject(config);
    const transport = context?.transport;
    if (!transport) throw new Error('SMTP transport unavailable');
    const at = context?.now ?? Date.now();
    const mime = buildMime(message, config, at);
    const recipients = Array.isArray(value.to) ? (value.to as Json[]).map(String) : [String(value.to)];
    const username = typeof value.user === 'string' ? value.user : undefined;
    const credential = typeof value.credentialRef === 'string' ? secretOf(context, value.credentialRef) : undefined;
    await transport({
      host: String(value.host),
      port: Number(value.port),
      secure: value.secure !== false,
      from: String(value.from),
      to: recipients,
      ...(username === undefined ? {} : { username }),
      ...(credential === undefined ? {} : { credential }),
      mime,
    }, context?.signal);
    return { at, messageId: `<${createHash('sha256').update(mime).digest('hex').slice(0, 40)}@suwen.local>` };
  },
  receive(payload) {
    const value = configObject(payload);
    if (typeof value.text !== 'string') return null;
    const at = typeof value.at === 'number' ? value.at : 0;
    const externalUserId = String(value.from ?? 'email');
    const externalId = typeof value.messageId === 'string' ? value.messageId : undefined;
    return inbound(externalUserId, value.text, at, externalId);
  },
};

// ---------------------------------------------------------------------------
// WeChat official account / WeCom app message
// ---------------------------------------------------------------------------

const wechatTokenCache = new Map<string, { token: string; expiresAt: number }>();

async function wechatAccessToken(value: Record<string, Json>, fetchImpl: FetchLike, context?: ChannelCallContext): Promise<string> {
  const corpId = String(value.corpId);
  const base = baseUrl(value, 'https://qyapi.weixin.qq.com');
  const secret = secretOf(context, String(value.credentialRef));
  const now = context?.now ?? Date.now();
  const cached = wechatTokenCache.get(`${base}|${corpId}`);
  if (cached && cached.expiresAt > now) return cached.token;
  const { status, body } = await requestJson(fetchImpl, `${base}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`, { method: 'GET' }, context);
  if (status !== 200 || typeof body?.access_token !== 'string') throw new Error(`WeChat gettoken failed with status ${status}`);
  const expiresIn = typeof body.eexpires_in === 'number' ? body.eexpires_in : typeof body.expires_in === 'number' ? body.expires_in : 7200;
  wechatTokenCache.set(`${base}|${corpId}`, { token: body.access_token, expiresAt: now + Math.max(60, expiresIn - 60) * 1000 });
  return body.access_token as string;
}

const wechat: ChannelAdapter = {
  id: 'wechat-official',
  capabilities: { inbound: true, outbound: true, attachments: false, maxText: 2048 },
  validate(config) {
    const value = configObject(config);
    text(value.corpId, 'corpId', 1, 64);
    const agentId = value.agentId;
    if (typeof agentId !== 'number' || !Number.isInteger(agentId) || agentId < 1) throw new ValidationError('agentId must be a positive integer');
    refName(value.credentialRef, 'credentialRef');
    if (value.toUser !== undefined) text(value.toUser, 'toUser', 1, 200);
    if (value.baseUrl !== undefined) httpUrl(value.baseUrl, 'baseUrl');
  },
  secretRefs(config) { return [refName(configObject(config).credentialRef, 'credentialRef')]; },
  async health(config, fetchImpl, context) {
    try {
      await wechatAccessToken(configObject(config), fetchImpl, context);
      return { status: 'ok', detail: 'wechat token acquired' };
    } catch (error) {
      return { status: 'failed', detail: `wechat unreachable: ${safeError(error)}` };
    }
  },
  async send(message, config, fetchImpl, context) {
    const value = configObject(config);
    const token = await wechatAccessToken(value, fetchImpl, context);
    const base = baseUrl(value, 'https://qyapi.weixin.qq.com');
    const body: Record<string, Json> = {
      touser: String(value.toUser ?? message.to ?? '@all'),
      msgtype: 'text',
      agentid: Number(value.agentId),
      text: { content: message.text },
    };
    const response = await requestJson(fetchImpl, `${base}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, jsonBody({ method: 'POST' }, body), context);
    if (response.status !== 200 || Number(response.body?.errcode ?? -1) !== 0) throw new Error(`WeChat message/send failed with status ${response.status}`);
    return { at: context?.now ?? Date.now(), ...(typeof response.body?.msgid === 'string' ? { messageId: response.body.msgid } : {}) };
  },
  receive(payload) {
    if (typeof payload === 'string') return receiveWechatXml(payload);
    const value = configObject(payload);
    if (typeof value.xml === 'string') return receiveWechatXml(value.xml);
    const content = typeof value.Content === 'string' ? value.Content : typeof value.content === 'string' ? value.content : undefined;
    if (content === undefined) return null;
    const from = typeof value.FromUserName === 'string' ? value.FromUserName : typeof value.fromUserName === 'string' ? value.fromUserName : 'wechat';
    const created = typeof value.CreateTime === 'number' ? value.CreateTime : typeof value.createTime === 'number' ? value.createTime : 0;
    const externalId = value.MsgId !== undefined ? String(value.MsgId) : value.msgId !== undefined ? String(value.msgId) : undefined;
    return inbound(from, content, created * 1000, externalId);
  },
};

function receiveWechatXml(xml: string): InboundMessage | null {
  const tag = (name: string): string | undefined => {
    const match = new RegExp(`<${name}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${name}>`).exec(xml);
    return match ? (match[1] ?? match[2]) : undefined;
  };
  const content = tag('Content');
  if (content === undefined) return null;
  const created = Number(tag('CreateTime') ?? 0);
  return inbound(tag('FromUserName') ?? 'wechat', content, Number.isFinite(created) ? created * 1000 : 0, tag('MsgId'));
}

export const CHANNEL_ADAPTERS: Record<ChannelType, ChannelAdapter> = {
  telegram, slack, discord, email, webhook, 'wechat-official': wechat,
};

// ---------------------------------------------------------------------------
// Minimal SMTP client (implicit TLS or plain TCP, AUTH LOGIN, no dependency)
// ---------------------------------------------------------------------------

export interface SmtpTransportOptions { timeoutMs?: number }

/** Create a dependency-free SMTP transport used by the daemon and by local fixture tests. */
export function createSmtpTransport(options: SmtpTransportOptions = {}): SmtpTransport {
  const timeoutMs = Math.max(1000, Math.min(options.timeoutMs ?? 10_000, 60_000));
  return (message, signal) => new Promise<void>((resolve, reject) => {
    const socket: Socket = message.secure
      ? tlsConnect({ host: message.host, port: message.port, servername: message.host })
      : netConnect({ host: message.host, port: message.port });
    let buffer = '';
    let settled = false;
    let multiline: string[] = [];
    let onResponse: ((response: { code: number; lines: string[] }) => void) | null = null;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try { socket.destroy(); } catch { /* already closed */ }
      if (error) reject(error); else resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => finish(new Error(`SMTP timed out after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = (): void => finish(new Error('SMTP aborted'));
    const onClose = (): void => finish(new Error('SMTP connection closed unexpectedly'));
    const onError = (error: Error): void => finish(new Error(`SMTP transport error: ${safeError(error)}`));
    const write = (line: string): void => { try { socket.write(`${line}\r\n`); } catch (error) { finish(new Error(`SMTP write failed: ${safeError(error)}`)); } };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      let boundary: number;
      while ((boundary = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const match = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!match) continue;
        multiline.push(match[3]);
        if (match[2] === '-') continue;
        const response = { code: Number(match[1]), lines: multiline };
        multiline = [];
        const handler = onResponse;
        onResponse = null;
        handler?.(response);
      }
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    let step = 0;
    let authenticated = false;
    const expect = (code: number, label: string, next: () => void): void => {
      onResponse = response => {
        if (response.code !== code) { finish(new Error(`SMTP ${label} rejected with code ${response.code}`)); return; }
        next();
      };
    };
    const afterAuth = (): void => {
      const expectData = (): void => {
        expect(354, 'DATA', () => {
          const normalized = message.mime.split('\r\n').map(line => (line.startsWith('.') ? `.${line}` : line)).join('\r\n');
          try { socket.write(`${normalized}\r\n.\r\n`); } catch (error) { finish(new Error(`SMTP write failed: ${safeError(error)}`)); return; }
          expect(250, 'message data', () => { write('QUIT'); finish(); });
        });
        write('DATA');
      };
      const expectRecipient = (remaining: string[]): void => {
        const [recipient, ...rest] = remaining;
        if (recipient === undefined) { expectData(); return; }
        expect(250, 'RCPT TO', () => expectRecipient(rest));
        write(`RCPT TO:<${recipient}>`);
      };
      expect(250, 'MAIL FROM', () => expectRecipient([...message.to]));
      write(`MAIL FROM:<${message.from}>`);
    };
    const greet = (): void => {
      expect(220, 'greeting', () => {
        write('EHLO suwen.local');
        expect(250, 'EHLO', () => {
          if (message.username && message.credential) {
            write('AUTH LOGIN');
            expect(334, 'AUTH LOGIN', () => {
              write(Buffer.from(String(message.username), 'utf8').toString('base64'));
              expect(334, 'AUTH username', () => {
                write(Buffer.from(String(message.credential), 'utf8').toString('base64'));
                expect(235, 'AUTH credential', () => { authenticated = true; afterAuth(); });
              });
            });
          } else {
            authenticated = true;
            afterAuth();
          }
        });
      });
    };
    void authenticated;
    void step;
    greet();
  });
}

// ---------------------------------------------------------------------------
// Channel service
// ---------------------------------------------------------------------------

export interface ChannelDeps {
  store: RecordStore;
  home?: string;
  clock?: () => number;
  fetch?: FetchLike;
  secrets?: SecretResolver;
  smtpTransport?: SmtpTransport;
  timeoutMs?: number;
  inboxCap?: number;
  adapters?: Partial<Record<ChannelType, ChannelAdapter>>;
}

export interface ChannelInboxEntry {
  id: string;
  channelId: string;
  direction: 'inbound' | 'outbound';
  externalUserId: string | null;
  externalId: string | null;
  text: string;
  at: number;
  status: string;
  truncated: boolean;
}

export interface ChannelAuditEntry {
  id: string;
  channelId: string;
  action: 'save' | 'test' | 'send' | 'receive' | 'remove';
  at: number;
  detail: string | null;
  recordId: string | null;
}

function recordData(row: RecordRow): Record<string, Json> {
  return row.data as unknown as Record<string, Json>;
}

export class ChannelService {
  private readonly store: RecordStore;
  private readonly clock: () => number;
  private readonly fetchImpl: FetchLike;
  private readonly secrets?: SecretResolver;
  private readonly smtpTransport?: SmtpTransport;
  private readonly timeoutMs: number;
  private readonly inboxCap: number;
  private readonly adapters: Record<ChannelType, ChannelAdapter>;

  constructor(deps: ChannelDeps) {
    this.store = deps.store;
    this.clock = deps.clock ?? Date.now;
    this.fetchImpl = deps.fetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
    this.secrets = deps.secrets;
    this.smtpTransport = deps.smtpTransport;
    this.timeoutMs = Math.max(10, Math.min(deps.timeoutMs ?? 10_000, 60_000));
    this.inboxCap = Math.max(1, Math.min(deps.inboxCap ?? 500, 500));
    this.adapters = { ...CHANNEL_ADAPTERS, ...(deps.adapters ?? {}) };
  }

  private adapter(type: ChannelType): ChannelAdapter {
    const adapter = this.adapters[type];
    if (!adapter) throw new ValidationError(`Unknown channel type: ${type}`);
    return adapter;
  }

  private row(id: string): RecordRow {
    if (typeof id !== 'string' || !id.length) throw new ValidationError('channel id required');
    const row = this.store.getRecord(id);
    if (!row || row.kind !== 'channel') throw new ValidationError(`Unknown channel: ${id}`);
    return row;
  }

  toView(row: RecordRow): ChannelView {
    const data = recordData(row);
    const type = data.type;
    if (!CHANNEL_TYPES.includes(type as ChannelType)) throw new ValidationError('Stored channel has unknown type');
    const health: ChannelView['health'] = data.health && typeof data.health === 'object'
      ? data.health as unknown as ChannelView['health']
      : { status: 'unknown', at: 0 };
    return {
      id: row.id,
      type: type as ChannelType,
      name: String(data.name),
      enabled: data.enabled !== false,
      readOnly: data.readOnly !== false,
      workspaceId: typeof data.workspaceId === 'string' ? data.workspaceId : null,
      config: (data.config ?? {}) as Json,
      health,
    };
  }

  list(): ChannelView[] { return this.store.listRecords('channel', { limit: 500 }).map(row => this.toView(row)); }
  get(id: string): ChannelView { return this.toView(this.row(id)); }

  private async resolveSecrets(adapter: ChannelAdapter, config: Json): Promise<{ values: Record<string, string>; list: string[] }> {
    const values: Record<string, string> = {};
    const list: string[] = [];
    for (const ref of adapter.secretRefs(config)) {
      let resolved: string | undefined;
      try { resolved = await this.secrets?.(ref); } catch (error) { throw new ValidationError(`Secret reference ${ref} could not be resolved`); }
      if (typeof resolved !== 'string' || !resolved.length) throw new ValidationError(`Missing secret for channel reference: ${ref}`);
      values[ref] = resolved;
      list.push(resolved);
    }
    return { values, list };
  }

  private audit(channelId: string, action: ChannelAuditEntry['action'], detail: string | null, recordId: string | null): void {
    this.store.putRecord('channelAudit', {
      channelId, action, at: this.clock(), detail, recordId,
    } as unknown as Json, { provenance: { kind: 'channel.audit', at: this.clock() } });
  }

  async save(input: Json): Promise<ChannelView> {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, Json> : null;
    if (!value) throw new ValidationError('channel save requires an object');
    const requestedId = typeof value.id === 'string' ? value.id : undefined;
    const existingRow = requestedId === undefined ? undefined : this.store.getRecord(requestedId);
    const existing = existingRow && existingRow.kind === 'channel' ? recordData(existingRow) : undefined;
    const type = value.type ?? existing?.type;
    if (typeof type !== 'string' || !CHANNEL_TYPES.includes(type as ChannelType)) throw new ValidationError('channel type must be one of telegram, slack, discord, email, webhook, wechat-official');
    const adapter = this.adapter(type as ChannelType);
    const config = (value.config ?? existing?.config) as Json;
    if (config === undefined) throw new ValidationError('channel config required');
    adapter.validate(config);
    assertNoSecretMaterial(config);
    const name = text(value.name, 'name', 1, 120);
    const enabled = boolean(value.enabled, 'enabled', existing?.enabled !== false);
    const readOnly = boolean(value.readOnly, 'readOnly', existing?.readOnly !== false);
    let workspaceId: string | null = null;
    if (value.workspaceId === null) workspaceId = null;
    else if (typeof value.workspaceId === 'string') workspaceId = text(value.workspaceId, 'workspaceId', 1, 200);
    else if (typeof existing?.workspaceId === 'string') workspaceId = existing.workspaceId;
    const data = {
      type, name, enabled, readOnly, workspaceId, config,
      health: existing?.health ?? { status: 'unknown', at: 0 },
      createdAt: typeof existing?.createdAt === 'number' ? existing.createdAt : this.clock(),
    };
    const row = this.store.putRecord('channel', data as unknown as Json, {
      ...(existingRow ? { id: existingRow.id, expectedVersion: existingRow.version } : {
        ...(requestedId === undefined ? {} : { id: requestedId }), expectedVersion: 0,
      }),
      provenance: { kind: 'channel.save', at: this.clock(), type },
    });
    this.audit(row.id, 'save', `${type} ${name}`, null);
    return this.toView(row);
  }

  async remove(id: string, expectedVersion?: number): Promise<{ ok: true }> {
    const row = this.row(id);
    this.store.deleteRecord(id, expectedVersion ?? row.version);
    this.audit(id, 'remove', 'channel removed', null);
    return { ok: true };
  }

  async test(id: string): Promise<ChannelView['health']> {
    const row = this.row(id);
    const view = this.toView(row);
    const adapter = this.adapter(view.type);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('channel test timed out')), this.timeoutMs);
    let health: ChannelView['health'];
    let secrets: string[] = [];
    try {
      const resolved = await this.resolveSecrets(adapter, view.config);
      secrets = resolved.list;
      const result = await withTimeout(adapter.health(view.config, this.fetchImpl, { secrets: resolved.values, signal: controller.signal, now: this.clock() }), this.timeoutMs, 'channel test');
      health = result.status === 'ok'
        ? { status: 'ok', at: this.clock(), ...(result.detail ? { detail: result.detail.slice(0, 500) } : {}) }
        : { status: 'failed', at: this.clock(), detail: redact(result.detail ?? 'channel test failed', secrets).slice(0, 500) };
    } catch (error) {
      const aborted = controller.signal.aborted;
      const detail = aborted ? `channel test timed out after ${this.timeoutMs}ms` : redact(safeError(error), secrets);
      health = { status: 'failed', at: this.clock(), detail: detail.slice(0, 500) };
    } finally {
      clearTimeout(timer);
    }
    this.store.putRecord('channel', { ...(recordData(row) as Record<string, Json>), health: health as unknown as Json } as Json, {
      id, expectedVersion: row.version, provenance: { kind: 'channel.test', at: this.clock(), status: health.status },
    });
    this.audit(id, 'test', health.status === 'ok' ? 'reachable' : health.detail ?? 'failed', null);
    return health;
  }

  async send(id: string, message: Json): Promise<{ ok: true; channelId: string; messageId?: string; at: number; recordId: string }> {
    const row = this.row(id);
    const view = this.toView(row);
    if (!view.enabled) throw new ValidationError(`Channel ${id} is disabled`);
    if (view.readOnly) throw new ValidationError(`Channel ${id} is read-only; save it with readOnly:false before sending`);
    const value = message && typeof message === 'object' && !Array.isArray(message) ? message as Record<string, Json> : null;
    if (!value) throw new ValidationError('channel send requires a message object');
    const textValue = text(value.text, 'text', 1, 100_000);
    const adapter = this.adapter(view.type);
    if (textValue.length > adapter.capabilities.maxText) throw new ValidationError(`text exceeds ${view.type} limit of ${adapter.capabilities.maxText} characters`);
    const outbound: OutboundMessage = {
      text: textValue,
      ...(typeof value.to === 'string' ? { to: text(value.to, 'to', 1, 320) } : {}),
      ...(typeof value.subject === 'string' ? { subject: text(value.subject, 'subject', 1, 200) } : {}),
    };
    const resolved = await this.resolveSecrets(adapter, view.config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('channel send timed out')), this.timeoutMs);
    try {
      const result = await withTimeout(adapter.send(outbound, view.config, this.fetchImpl, {
        secrets: resolved.values,
        ...(this.smtpTransport === undefined ? {} : { transport: this.smtpTransport }),
        signal: controller.signal,
        now: this.clock(),
      }), this.timeoutMs, 'channel send');
      const at = result.at || this.clock();
      const record = this.store.putRecord('channelMessage', {
        channelId: id, direction: 'outbound', externalUserId: null, externalId: null,
        text: textValue, at, status: 'sent', messageId: result.messageId ?? null, truncated: false,
      } as unknown as Json, { provenance: { kind: 'channel.send', at, channelId: id } });
      this.audit(id, 'send', result.messageId ? `sent ${result.messageId}` : 'sent', record.id);
      this.pruneInbox();
      return { ok: true, channelId: id, ...(result.messageId === undefined ? {} : { messageId: result.messageId }), at, recordId: record.id };
    } catch (error) {
      const aborted = controller.signal.aborted;
      const detail = aborted ? `channel send timed out after ${this.timeoutMs}ms` : redact(`channel send failed: ${safeError(error)}`, resolved.list);
      this.audit(id, 'send', detail, null);
      throw new Error(aborted ? detail : redact(safeError(error), resolved.list));
    } finally {
      clearTimeout(timer);
    }
  }

  inbox(options: { channelId?: string; limit?: number } = {}): ChannelInboxEntry[] {
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 100), 500));
    const rows = this.store.listRecords('channelMessage', { limit: 500 });
    return rows
      .filter(row => options.channelId === undefined || recordData(row).channelId === options.channelId)
      .slice(0, limit)
      .map(row => {
        const data = recordData(row);
        return {
          id: row.id,
          channelId: String(data.channelId ?? ''),
          direction: data.direction === 'outbound' ? 'outbound' as const : 'inbound' as const,
          externalUserId: typeof data.externalUserId === 'string' ? data.externalUserId : null,
          externalId: typeof data.externalId === 'string' ? data.externalId : null,
          text: String(data.text ?? ''),
          at: typeof data.at === 'number' ? data.at : row.createdAt,
          status: String(data.status ?? 'received'),
          truncated: data.truncated === true,
        };
      });
  }

  auditLog(options: { channelId?: string; limit?: number } = {}): ChannelAuditEntry[] {
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 100), 500));
    return this.store.listRecords('channelAudit', { limit }).filter(row => options.channelId === undefined || recordData(row).channelId === options.channelId).map(row => {
      const data = recordData(row);
      return {
        id: row.id,
        channelId: String(data.channelId ?? ''),
        action: String(data.action ?? 'save') as ChannelAuditEntry['action'],
        at: typeof data.at === 'number' ? data.at : row.createdAt,
        detail: typeof data.detail === 'string' ? data.detail : null,
        recordId: typeof data.recordId === 'string' ? data.recordId : null,
      };
    });
  }

  async receive(id: string, payload: Json): Promise<{ message: InboundMessage; recordId: string; duplicate: boolean }> {
    const row = this.row(id);
    const view = this.toView(row);
    const adapter = this.adapter(view.type);
    const normalized = adapter.receive(payload);
    if (!normalized) throw new ValidationError(`Unrecognized ${view.type} inbound payload`);
    const textValue = normalized.text;
    if (!textValue.trim()) throw new ValidationError('Inbound channel text must not be empty');
    const truncated = textValue.length > MAX_INBOUND_TEXT;
    const externalId = normalized.externalId ?? createHash('sha256').update(`${id}\u0000${normalized.externalUserId}\u0000${normalized.at}\u0000${textValue}`).digest('hex').slice(0, 32);
    const existing = this.store.listRecords('channelMessage', { limit: this.inboxCap }).find(candidate => {
      const data = recordData(candidate);
      return data.channelId === id && data.direction !== 'outbound' && data.externalId === externalId;
    });
    if (existing) {
      const data = recordData(existing);
      return {
        message: {
          channelId: id, externalUserId: String(data.externalUserId ?? normalized.externalUserId),
          text: String(data.text ?? textValue), at: typeof data.at === 'number' ? data.at : this.clock(),
          ...(typeof data.externalId === 'string' ? { externalId: data.externalId } : {}),
        },
        recordId: existing.id, duplicate: true,
      };
    }
    const at = normalized.at > 0 ? normalized.at : this.clock();
    const message: InboundMessage = {
      channelId: id,
      externalUserId: normalized.externalUserId.slice(0, 200),
      text: truncated ? textValue.slice(0, MAX_INBOUND_TEXT) : textValue,
      at,
      externalId,
    };
    const record = this.store.putRecord('channelMessage', {
      channelId: id, direction: 'inbound', externalUserId: message.externalUserId, externalId,
      text: message.text, at, status: 'received', truncated,
    } as unknown as Json, { provenance: { kind: 'channel.receive', at, channelId: id } });
    this.pruneInbox();
    this.audit(id, 'receive', truncated ? 'received truncated text' : 'received', record.id);
    return { message, recordId: record.id, duplicate: false };
  }

  private pruneInbox(): void {
    const rows = this.store.listRecords('channelMessage', { limit: 500 });
    if (rows.length <= this.inboxCap) return;
    for (const row of rows.slice(this.inboxCap)) {
      try { this.store.deleteRecord(row.id); } catch { /* another writer may have removed it */ }
    }
  }
}

function redact(message: string, secrets: string[]): string {
  let out = safeError(message);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      value => { clearTimeout(timer); resolvePromise(value); },
      error => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}
