import Anthropic from '@anthropic-ai/sdk';
import { HttpError, type ChatRequest, type ChatResponse, type Env } from './types.ts';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

/** Claude is unavailable right now, so the caller may try Gemini instead. */
export class ClaudeUnavailableError extends Error {}

/**
 * Drop blocks that came before a mid-output refusal fallback, which must not
 * be echoed back. Non-streaming responses normally have none, but be safe.
 */
function echoableContent(content: Anthropic.Beta.BetaContentBlock[]) {
  const lastFallback = content.findLastIndex((b) => b.type === 'fallback');
  if (lastFallback < 0) {
    return content;
  }
  return content.filter(
    (b, i) =>
      i >= lastFallback ||
      (b.type !== 'thinking' && b.type !== 'redacted_thinking' && b.type !== 'tool_use'),
  );
}

export async function callClaude(env: Env, body: ChatRequest): Promise<ChatResponse> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new ClaudeUnavailableError('ANTHROPIC_API_KEY is not set on the Worker');
  }
  const effort: Effort = EFFORTS.includes(env.CLAUDE_EFFORT as Effort)
    ? (env.CLAUDE_EFFORT as Effort)
    : 'medium';

  // One retry, then let the caller fall back to Gemini rather than waiting longer
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
  try {
    const response = await client.beta.messages.create({
      model: env.CLAUDE_MODEL,
      max_tokens: 16000,
      // On a policy decline, re-run on Anthropic's recommended fallback model
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort },
      // The system prompt and tools are the same on every request, so cache them
      cache_control: { type: 'ephemeral' },
      system: body.system,
      tools: body.tools,
      messages: body.messages,
    });
    return {
      provider: 'claude',
      content: echoableContent(response.content),
      stop_reason: response.stop_reason,
    };
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      throw new ClaudeUnavailableError('Claude rate limit hit');
    } else if (e instanceof Anthropic.InternalServerError) {
      throw new ClaudeUnavailableError(`Claude is unavailable (HTTP ${e.status})`);
    } else if (e instanceof Anthropic.APIConnectionError) {
      throw new ClaudeUnavailableError('Could not reach Claude');
    } else if (e instanceof Anthropic.APIError && e.status) {
      // Bad requests and auth errors are bugs to fix, not outages to hide
      throw new HttpError(e.status, `Claude returned HTTP ${e.status}: ${e.message}`);
    }
    throw e;
  }
}
