import type Anthropic from '@anthropic-ai/sdk';

export interface Env {
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  /** Shared secret the DIM panel sends as `Authorization: Bearer <token>`. */
  PROXY_TOKEN?: string;
  CLAUDE_MODEL: string;
  CLAUDE_EFFORT: string;
  GEMINI_MODEL: string;
  ALLOWED_ORIGINS: string;
}

/**
 * Body of `POST /chat`: an Anthropic Messages conversation. The Worker picks the
 * model, so callers can't run up costs on a different one.
 */
export interface ChatRequest {
  system: string;
  tools: Anthropic.Beta.BetaTool[];
  messages: Anthropic.Beta.BetaMessageParam[];
  /** Gemini thought signatures for Gemini-made tool calls, by tool_use id. */
  geminiSignatures?: Record<string, string>;
}

export interface ChatResponse {
  provider: 'claude' | 'gemini';
  /** The assistant turn, in Anthropic format. Append it to the history unchanged. */
  content: Anthropic.Beta.BetaContentBlock[];
  stop_reason: Anthropic.Beta.BetaStopReason | null;
  /** Why Claude wasn't used, when provider is gemini. */
  fallbackReason?: string;
  /** New Gemini thought signatures to send back on later requests. */
  geminiSignatures?: Record<string, string>;
}

/** An error to return to the caller with an HTTP status. */
export class HttpError extends Error {
  status: number;
  headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}
