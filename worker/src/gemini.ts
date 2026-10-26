/**
 * Gemini fallback. Translates the Anthropic-format conversation to Gemini's
 * generateContent format and the reply back, so the DIM panel only ever deals
 * with one format.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { HttpError, type ChatRequest, type ChatResponse, type Env } from './types.ts';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** tool_use ids we make up for Gemini's calls. Claude's calls are replayed as text. */
export const GEMINI_TOOL_ID_PREFIX = 'toolu_gemini_';

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GenerateContentResponse {
  candidates?: { content?: GeminiContent; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

function toolResultText(content: Anthropic.Beta.BetaToolResultBlockParam['content']) {
  if (typeof content === 'string') {
    return content;
  }
  return (content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
}

function asObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON
  }
  return { result: text };
}

/**
 * Convert the conversation to Gemini contents. Gemini needs its own thought
 * signatures on its function calls, which Claude's calls don't have, so
 * Claude's tool calls and results are given to Gemini as text instead.
 */
export function toGeminiContents(
  messages: Anthropic.Beta.BetaMessageParam[],
  signatures: Record<string, string>,
): GeminiContent[] {
  const toolNames = new Map<string, string>();
  const contents: GeminiContent[] = [];
  for (const message of messages) {
    const blocks =
      typeof message.content === 'string'
        ? [{ type: 'text' as const, text: message.content }]
        : (message.content ?? []);
    const parts: GeminiPart[] = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        if (block.text) {
          parts.push({ text: block.text });
        }
      } else if (block.type === 'tool_use') {
        toolNames.set(block.id, block.name);
        if (block.id.startsWith(GEMINI_TOOL_ID_PREFIX)) {
          const signature = signatures[block.id];
          parts.push({
            functionCall: { name: block.name, args: block.input as Record<string, unknown> },
            ...(signature ? { thoughtSignature: signature } : {}),
          });
        } else {
          parts.push({ text: `[Called ${block.name} with ${JSON.stringify(block.input)}]` });
        }
      } else if (block.type === 'tool_result') {
        const name = toolNames.get(block.tool_use_id) ?? 'unknown_tool';
        const text = toolResultText(block.content);
        if (block.tool_use_id.startsWith(GEMINI_TOOL_ID_PREFIX)) {
          parts.push({ functionResponse: { name, response: asObject(text) } });
        } else {
          parts.push({ text: `[Result of ${name}: ${text}]` });
        }
      }
      // Thinking and fallback blocks are Claude-only, so they're left out
    }
    if (!parts.length) {
      continue;
    }
    const role = message.role === 'assistant' ? 'model' : 'user';
    const last = contents.at(-1);
    if (last?.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }
  return contents;
}

export async function callGemini(
  env: Env,
  body: ChatRequest,
  fallbackReason: string,
): Promise<ChatResponse> {
  if (!env.GEMINI_API_KEY) {
    throw new HttpError(503, `${fallbackReason}, and GEMINI_API_KEY is not set for the fallback`);
  }
  const request = {
    contents: toGeminiContents(body.messages, body.geminiSignatures ?? {}),
    tools: [
      {
        functionDeclarations: body.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      },
    ],
    systemInstruction: { parts: [{ text: body.system }] },
    ...(body.toolChoice === 'none'
      ? { toolConfig: { functionCallingConfig: { mode: 'NONE' } } }
      : {}),
  };

  let upstream: Response;
  try {
    upstream = await fetch(
      `${GEMINI_BASE}/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(request),
      },
    );
  } catch (e) {
    throw new HttpError(502, `${fallbackReason}, and Gemini couldn't be reached: ${String(e)}`);
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    let message = upstream.status === 429 ? 'Gemini free-tier rate limit hit' : '';
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      message ||= parsed.error?.message ?? '';
    } catch {
      // Not JSON
    }
    const retryAfter = upstream.headers.get('Retry-After');
    throw new HttpError(
      upstream.status,
      `${fallbackReason}, and Gemini returned HTTP ${upstream.status}${message ? `: ${message}` : ''}`,
      retryAfter ? { 'Retry-After': retryAfter } : {},
    );
  }

  const json = JSON.parse(text) as GenerateContentResponse;
  const candidate = json.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  const geminiSignatures: Record<string, string> = {};
  for (const part of parts) {
    if (part.functionCall) {
      const id = `${GEMINI_TOOL_ID_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`;
      if (part.thoughtSignature) {
        geminiSignatures[id] = part.thoughtSignature;
      }
      content.push({
        type: 'tool_use',
        id,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
        caller: { type: 'direct' },
      });
    } else if (part.text && !part.thought) {
      content.push({ type: 'text', text: part.text, citations: null });
    }
  }
  if (!content.length) {
    const reason = json.promptFeedback?.blockReason ?? candidate?.finishReason ?? 'no content';
    throw new HttpError(502, `${fallbackReason}, and Gemini didn't answer (${reason})`);
  }
  return {
    provider: 'gemini',
    content,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    fallbackReason,
    geminiSignatures,
  };
}
