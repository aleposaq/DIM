import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GEMINI_TOOL_ID_PREFIX, toGeminiContents } from '../src/gemini.ts';
import worker from '../src/index.ts';
import type { ChatResponse, Env } from '../src/types.ts';

const TOKEN = 'test-token';
const ORIGIN = 'https://localhost:8080';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ANTHROPIC_API_KEY: 'sk-ant-test',
    GEMINI_API_KEY: 'gemini-test',
    PROXY_TOKEN: TOKEN,
    CLAUDE_MODEL: 'claude-opus-5-5',
    CLAUDE_EFFORT: 'medium',
    GEMINI_MODEL: 'gemini-3.5-flash-lite',
    ALLOWED_ORIGINS: ORIGIN,
    ...overrides,
  };
}

const chatBody = {
  system: 'You manage a Destiny 2 inventory.',
  tools: [
    {
      name: 'list_characters',
      description: 'List characters',
      input_schema: { type: 'object', properties: {} },
    },
  ],
  messages: [{ role: 'user', content: 'Who am I?' }],
};

function chatRequest(
  body: unknown = chatBody,
  headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
) {
  return new Request('https://w.example/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

interface Call {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
let respond: (url: string) => Response;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return respond(url);
  }) as typeof fetch;
});

function claudeMessage(content: unknown[], stop_reason = 'end_turn') {
  return Response.json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

function geminiReply(parts: unknown[]) {
  return Response.json({ candidates: [{ content: { role: 'model', parts } }] });
}

const isClaude = (url: string) => url.startsWith('https://api.anthropic.com');

describe('access control', () => {
  beforeEach(() => {
    respond = () => claudeMessage([{ type: 'text', text: 'hi' }]);
  });

  it('rejects other origins', async () => {
    const res = await worker.fetch(
      chatRequest(chatBody, { Origin: 'https://evil.example' }),
      makeEnv(),
    );
    assert.equal(res.status, 403);
  });

  it('requires the access token', async () => {
    const missing = await worker.fetch(chatRequest(chatBody, { Origin: ORIGIN }), makeEnv());
    assert.equal(missing.status, 401);
    const wrong = await worker.fetch(
      chatRequest(chatBody, { Origin: ORIGIN, Authorization: 'Bearer nope' }),
      makeEnv(),
    );
    assert.equal(wrong.status, 401);
    // No Origin (curl) still needs the token
    const curl = await worker.fetch(chatRequest(chatBody, {}), makeEnv());
    assert.equal(curl.status, 401);
    assert.equal(calls.length, 0);
  });

  it('fails closed when PROXY_TOKEN is not set', async () => {
    const res = await worker.fetch(chatRequest(), makeEnv({ PROXY_TOKEN: undefined }));
    assert.equal(res.status, 500);
    assert.equal(calls.length, 0);
  });

  it('answers preflight without a token and allows the Authorization header', async () => {
    const res = await worker.fetch(
      new Request('https://w.example/chat', { method: 'OPTIONS', headers: { Origin: ORIGIN } }),
      makeEnv(),
    );
    assert.equal(res.status, 204);
    assert.match(res.headers.get('Access-Control-Allow-Headers')!, /Authorization/);
  });

  it('rejects oversized bodies', async () => {
    const big = { ...chatBody, system: 'x'.repeat(2.1 * 1024 * 1024) };
    const res = await worker.fetch(chatRequest(big), makeEnv());
    assert.equal(res.status, 413);
  });
});

describe('Claude', () => {
  it('sends the conversation to Claude with fallbacks and caching', async () => {
    respond = () => claudeMessage([{ type: 'text', text: 'You have one Titan.' }]);
    const res = await worker.fetch(chatRequest(), makeEnv());
    assert.equal(res.status, 200);
    const body = (await res.json()) as ChatResponse;
    assert.equal(body.provider, 'claude');
    assert.deepEqual(body.content, [{ type: 'text', text: 'You have one Titan.' }]);

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(isClaude(call.url));
    assert.match(call.headers.get('anthropic-beta')!, /server-side-fallback-2026-07-01/);
    assert.equal(call.body.model, 'claude-opus-5-5');
    assert.equal(call.body.fallbacks, 'default');
    assert.deepEqual(call.body.output_config, { effort: 'medium' });
    assert.deepEqual(call.body.cache_control, { type: 'ephemeral' });
    assert.equal(call.body.thinking, undefined);
  });

  it('passes bad requests through instead of falling back', async () => {
    respond = () =>
      Response.json(
        { type: 'error', error: { type: 'invalid_request_error', message: 'bad tools' } },
        { status: 400 },
      );
    const res = await worker.fetch(chatRequest(), makeEnv());
    assert.equal(res.status, 400);
    assert.ok(calls.every((c) => isClaude(c.url)));
  });

  it('drops blocks before a mid-output fallback', async () => {
    respond = () =>
      claudeMessage([
        { type: 'thinking', thinking: '', signature: 'abc' },
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
        { type: 'text', text: 'Answer' },
      ]);
    const body = (await (await worker.fetch(chatRequest(), makeEnv())).json()) as ChatResponse;
    assert.deepEqual(
      body.content.map((b) => b.type),
      ['fallback', 'text'],
    );
  });
});

describe('Gemini fallback', () => {
  it('falls back to Gemini when Claude is rate limited', async () => {
    respond = (url) =>
      isClaude(url)
        ? Response.json(
            { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
            { status: 429, headers: { 'retry-after-ms': '1' } },
          )
        : geminiReply([
            { functionCall: { name: 'list_characters', args: {} }, thoughtSignature: 'sig1' },
          ]);
    const res = await worker.fetch(chatRequest(), makeEnv());
    assert.equal(res.status, 200);
    const body = (await res.json()) as ChatResponse;
    assert.equal(body.provider, 'gemini');
    assert.equal(body.fallbackReason, 'Claude rate limit hit');
    assert.equal(body.stop_reason, 'tool_use');
    const [toolUse] = body.content;
    assert.equal(toolUse.type, 'tool_use');
    assert.ok(toolUse.type === 'tool_use' && toolUse.id.startsWith(GEMINI_TOOL_ID_PREFIX));
    assert.deepEqual(body.geminiSignatures, {
      [toolUse.type === 'tool_use' ? toolUse.id : '']: 'sig1',
    });

    const gemini = calls.at(-1)!;
    assert.match(gemini.url, /gemini-3\.5-flash-lite:generateContent$/);
    assert.equal(gemini.headers.get('x-goog-api-key'), 'gemini-test');
    // One original attempt plus one retry before falling back
    assert.equal(calls.filter((c) => isClaude(c.url)).length, 2);
  });

  it('uses Gemini directly when there is no Anthropic key', async () => {
    respond = () => geminiReply([{ text: 'Hi from Gemini' }]);
    const res = await worker.fetch(chatRequest(), makeEnv({ ANTHROPIC_API_KEY: undefined }));
    const body = (await res.json()) as ChatResponse;
    assert.equal(body.provider, 'gemini');
    assert.equal(calls.length, 1);
  });

  it('reports both failures when Gemini fails too', async () => {
    respond = (url) =>
      isClaude(url)
        ? new Response('overloaded', { status: 529, headers: { 'retry-after-ms': '1' } })
        : Response.json({ error: { message: 'quota' } }, { status: 429 });
    const res = await worker.fetch(chatRequest(), makeEnv());
    assert.equal(res.status, 429);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(
      body.error.message,
      /Claude is unavailable \(HTTP 529\).*Gemini free-tier rate limit/,
    );
  });
});

describe('toGeminiContents', () => {
  it("replays Claude's tool calls as text and Gemini's as function calls", () => {
    const geminiId = `${GEMINI_TOOL_ID_PREFIX}abc`;
    const contents = toGeminiContents(
      [
        { role: 'user', content: 'Max my power' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 'claude-sig' },
            { type: 'tool_use', id: 'toolu_claude1', name: 'list_characters', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_claude1', content: '{"characters":[]}' },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: geminiId, name: 'equip_max_power', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: geminiId, content: '{"cancelled":true}' }],
        },
        { role: 'user', content: 'ok' },
      ],
      { [geminiId]: 'gem-sig' },
    );
    assert.deepEqual(contents, [
      { role: 'user', parts: [{ text: 'Max my power' }] },
      { role: 'model', parts: [{ text: '[Called list_characters with {}]' }] },
      { role: 'user', parts: [{ text: '[Result of list_characters: {"characters":[]}]' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'equip_max_power', args: {} }, thoughtSignature: 'gem-sig' },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'equip_max_power', response: { cancelled: true } } },
          { text: 'ok' },
        ],
      },
    ]);
  });
});
