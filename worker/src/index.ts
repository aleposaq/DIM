/**
 * dim-ai-proxy: a small Cloudflare Worker for DIM's AI assistant. It keeps the
 * API keys off the browser, calls Claude, and falls back to Gemini when Claude
 * is rate limited, overloaded, unreachable, or not configured.
 *
 * Only `POST /chat` and `OPTIONS` (CORS preflight) are allowed, and `POST`
 * needs `Authorization: Bearer <PROXY_TOKEN>`.
 */
import { callClaude, ClaudeUnavailableError } from './claude.ts';
import { callGemini } from './gemini.ts';
import { HttpError, type ChatRequest, type Env } from './types.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function allowedOrigins(env: Env) {
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function errorResponse(status: number, message: string, headers: Record<string, string> = {}) {
  return json({ error: { code: status, message } }, status, headers);
}

/** Compare without leaking how many leading characters matched. */
function tokensMatch(a: string, b: string) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

function parseChatRequest(bodyText: string): ChatRequest {
  let body: Partial<ChatRequest>;
  try {
    body = JSON.parse(bodyText) as Partial<ChatRequest>;
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw new HttpError(400, 'Body must include a non-empty messages array');
  }
  if (!Array.isArray(body.tools) || typeof body.system !== 'string') {
    throw new HttpError(400, 'Body must include tools and system');
  }
  // Only forward the fields we expect
  return {
    system: body.system,
    tools: body.tools,
    messages: body.messages,
    geminiSignatures: body.geminiSignatures ?? {},
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // Browsers always send Origin on cross-origin requests. Requests without
    // one (curl, scripts) still need the token below.
    if (origin !== null && !allowedOrigins(env).includes(origin)) {
      return errorResponse(403, 'Origin not allowed');
    }
    const cors = origin ? corsHeaders(origin) : {};

    if (url.pathname !== '/chat') {
      return errorResponse(404, 'Not found', cors);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return errorResponse(405, 'Method not allowed', { ...cors, Allow: 'POST, OPTIONS' });
    }

    if (!env.PROXY_TOKEN) {
      return errorResponse(500, 'PROXY_TOKEN is not configured on the Worker', cors);
    }
    const auth = request.headers.get('Authorization') ?? '';
    if (!tokensMatch(auth, `Bearer ${env.PROXY_TOKEN}`)) {
      return errorResponse(401, 'Missing or wrong access token', cors);
    }

    if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) {
      return errorResponse(413, 'Conversation too long, start a new chat', cors);
    }
    const bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) {
      return errorResponse(413, 'Conversation too long, start a new chat', cors);
    }

    try {
      const body = parseChatRequest(bodyText);
      try {
        return json(await callClaude(env, body), 200, cors);
      } catch (e) {
        if (e instanceof ClaudeUnavailableError) {
          return json(await callGemini(env, body, e.message), 200, cors);
        }
        throw e;
      }
    } catch (e) {
      if (e instanceof HttpError) {
        return errorResponse(e.status, e.message, { ...cors, ...e.headers });
      }
      return errorResponse(500, `Unexpected error: ${String(e)}`, cors);
    }
  },
};
