/**
 * dim-ai-proxy: a tiny Cloudflare Worker that forwards Gemini generateContent
 * requests from DIM's AI assistant, so the API key never reaches the browser.
 *
 * Only `POST /chat` and `OPTIONS` (CORS preflight) are allowed.
 */

interface Env {
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  ALLOWED_ORIGINS: string;
}

const MAX_BODY_BYTES = 200 * 1024;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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
    'Access-Control-Allow-Headers': 'Content-Type',
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // Browsers always send Origin on cross-origin requests. Requests without
    // one (curl, scripts) are allowed so the Worker can be tested, but get no
    // CORS headers, so other websites can't read the response.
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

    if (!env.GEMINI_API_KEY) {
      return errorResponse(500, 'GEMINI_API_KEY is not configured on the Worker', cors);
    }

    const declaredLength = Number(request.headers.get('Content-Length') ?? 0);
    if (declaredLength > MAX_BODY_BYTES) {
      return errorResponse(413, 'Request body too large', cors);
    }
    const bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) {
      return errorResponse(413, 'Request body too large', cors);
    }

    let body: { contents?: unknown; tools?: unknown; systemInstruction?: unknown };
    try {
      body = JSON.parse(bodyText);
    } catch {
      return errorResponse(400, 'Body must be JSON', cors);
    }
    if (!Array.isArray(body.contents)) {
      return errorResponse(400, 'Body must include a contents array', cors);
    }

    // Only forward the fields we expect, so the client can't change other settings.
    const geminiBody = {
      contents: body.contents,
      tools: body.tools,
      systemInstruction: body.systemInstruction,
    };

    let upstream: Response;
    try {
      upstream = await fetch(
        `${GEMINI_BASE}/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.GEMINI_API_KEY,
          },
          body: JSON.stringify(geminiBody),
        },
      );
    } catch (e) {
      return errorResponse(502, `Could not reach Gemini: ${String(e)}`, cors);
    }

    const text = await upstream.text();
    if (!upstream.ok) {
      // Pass Google's error through, but make sure there's always a readable message.
      let message = `Gemini returned HTTP ${upstream.status}`;
      if (upstream.status === 429) {
        message = 'Gemini free-tier rate limit hit';
      }
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) {
          message = `${message}: ${parsed.error.message}`;
        }
      } catch {
        // Not JSON, use the default message
      }
      const retryAfter = upstream.headers.get('Retry-After');
      return errorResponse(upstream.status, message, {
        ...cors,
        ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
      });
    }

    // Return Google's JSON unchanged.
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  },
};
