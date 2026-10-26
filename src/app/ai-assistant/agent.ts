import type Anthropic from '@anthropic-ai/sdk';
import { allItemsSelector } from 'app/inventory/selectors';
import { DimThunkDispatch, RootState } from 'app/store/types';
import { errorMessage } from 'app/utils/errors';
import memoizeOne from 'memoize-one';
import { buildCraftingGuide } from './build-guide';
import { searchCheatSheet } from './search-cheat-sheet';
import { aiTools, aiToolsByName, runTool, summarizeTool, ToolArgs, ToolResult } from './tools';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;
type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type ToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

/** Max tool calls the model may make while answering one user message. */
export const MAX_TOOL_CALLS_PER_MESSAGE = 20;

/** Stay under the proxy Worker's 2 MB body cap. */
const MAX_REQUEST_BYTES = 1.9 * 1024 * 1024;

export const RATE_LIMIT_MESSAGE = 'Claude and Gemini are both rate limited, try again in a minute.';
export const TOO_LONG_MESSAGE = 'This conversation is too long. Start a new chat.';

/**
 * The conversation, in Claude's Messages format. It's append-only: Claude
 * rejects a history whose earlier turns were edited once it has replayed its
 * thinking blocks, so messages are never changed or removed.
 */
export interface Conversation {
  messages: MessageParam[];
  /** Gemini thought signatures for tool calls Gemini made, by tool_use id. */
  geminiSignatures: Record<string, string>;
}

export const emptyConversation: Conversation = { messages: [], geminiSignatures: {} };

/** What the proxy Worker returns from POST /chat (see worker/src/types.ts). */
interface ChatResponse {
  provider: 'claude' | 'gemini';
  content: ContentBlock[];
  stop_reason: Anthropic.Beta.BetaStopReason | null;
  fallbackReason?: string;
  geminiSignatures?: Record<string, string>;
}

/** A line to show in the chat transcript. */
export interface ChatLine {
  kind: 'user' | 'model' | 'activity' | 'error';
  text: string;
}

/**
 * A mutating tool call waiting for the user to click Confirm or Cancel. Holds
 * everything needed to resume the turn afterwards.
 */
export interface PendingAction {
  call: ToolUseBlock;
  summary: string;
  /** Other calls from the same model response that haven't run yet. */
  remainingCalls: ToolUseBlock[];
  /** tool_result blocks collected so far for that model response. */
  results: ToolResultBlockParam[];
  toolCallsUsed: number;
}

export interface TurnResult {
  conversation: Conversation;
  pending?: PendingAction;
}

export interface AgentDeps {
  /** Base URL of the proxy Worker. */
  proxyUrl: string;
  /** The Worker's PROXY_TOKEN. */
  proxyToken: string;
  getState: () => RootState;
  dispatch: DimThunkDispatch;
  /** Called for each new line to show in the transcript. */
  onLine: (line: ChatLine) => void;
}

// The system prompt and tools must stay byte-identical for the whole
// conversation, both for Claude's thinking blocks and for prompt caching.
const systemPrompt = memoizeOne(() =>
  [
    "You manage a Destiny 2 player's inventory through DIM. Use tools; never invent item names or ids. Use DIM search syntax in search_items.",
    'Item indexes come from search_items. Character ids come from list_characters. Loadout ids come from list_loadouts.',
    'Tools that move, equip, apply or save ask the player to confirm first. If a result says cancelled, acknowledge it and do not retry.',
    'Keep answers short. Refer to items by name, never by index.',
    '',
    buildCraftingGuide,
    '',
    searchCheatSheet(),
  ].join('\n'),
);

const toolDefinitions = memoizeOne((): Anthropic.Beta.BetaTool[] =>
  aiTools.map(({ declaration }) => ({
    name: declaration.name,
    description: declaration.description,
    input_schema: declaration.parameters as Anthropic.Beta.BetaTool.InputSchema,
  })),
);

class ProxyError extends Error {}

function chatUrl(proxyUrl: string) {
  const base = proxyUrl.trim().replace(/\/+$/, '');
  return base.endsWith('/chat') ? base : `${base}/chat`;
}

async function callModel(
  deps: AgentDeps,
  conversation: Conversation,
  toolsOff: boolean,
): Promise<ChatResponse> {
  const body = JSON.stringify({
    system: systemPrompt(),
    tools: toolDefinitions(),
    messages: conversation.messages,
    geminiSignatures: conversation.geminiSignatures,
    ...(toolsOff ? { toolChoice: 'none' } : {}),
  });
  if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) {
    throw new ProxyError(TOO_LONG_MESSAGE);
  }

  let response: Response;
  try {
    response = await fetch(chatUrl(deps.proxyUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deps.proxyToken}`,
      },
      body,
    });
  } catch (e) {
    throw new ProxyError(`Could not reach the AI proxy: ${errorMessage(e)}`);
  }

  if (response.status === 429) {
    throw new ProxyError(RATE_LIMIT_MESSAGE);
  } else if (response.status === 401) {
    throw new ProxyError('The AI proxy rejected the access token. Check Settings.');
  } else if (response.status === 413) {
    throw new ProxyError(TOO_LONG_MESSAGE);
  }
  let json: ChatResponse & { error?: { message?: string } };
  try {
    json = (await response.json()) as typeof json;
  } catch {
    throw new ProxyError(`AI proxy returned HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new ProxyError(json.error?.message ?? `AI proxy returned HTTP ${response.status}`);
  }
  return json;
}

function inputArgs(call: ToolUseBlock): ToolArgs {
  const input = call.input;
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as ToolArgs) : {};
}

/** A transcript line for a read-only tool call, e.g. "Searched: is:exotic is:void". */
function activityLine(call: ToolUseBlock, state: RootState) {
  const args = inputArgs(call);
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  switch (call.name) {
    case 'search_items':
      return `Searched: ${str(args.query)}`;
    case 'describe_item': {
      const item = allItemsSelector(state).find((i) => i.index === args.itemIndex);
      return `Looked up ${item?.name ?? 'an item'}`;
    }
    case 'list_characters':
      return 'Listed characters';
    case 'lookup_game_data':
      return `Looked up: ${str(args.name)}`;
    case 'describe_subclass':
      return args.subclass ? `Checked ${str(args.subclass)} subclass` : 'Checked subclass';
    case 'describe_artifact':
      return 'Checked artifact perks';
    case 'list_loadouts':
      return args.classType ? `Listed ${str(args.classType)} loadouts` : 'Listed loadouts';
    default:
      return `Ran ${call.name}`;
  }
}

function toolResult(call: ToolUseBlock, result: ToolResult): ToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: call.id,
    content: JSON.stringify(result),
    ...('error' in result ? { is_error: true } : {}),
  };
}

function append(conversation: Conversation, message: MessageParam): Conversation {
  return { ...conversation, messages: [...conversation.messages, message] };
}

/**
 * Run the tool calls from one model response in order. Stops at the first
 * mutating call and returns it as a pending action.
 */
async function runCalls(
  deps: AgentDeps,
  calls: ToolUseBlock[],
  results: ToolResultBlockParam[],
  toolCallsUsed: number,
): Promise<{ results: ToolResultBlockParam[]; toolCallsUsed: number; pending?: PendingAction }> {
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    toolCallsUsed++;
    if (toolCallsUsed > MAX_TOOL_CALLS_PER_MESSAGE) {
      results = [
        ...results,
        toolResult(call, {
          error: 'Tool call limit reached for this message. Answer with what you have.',
        }),
      ];
      continue;
    }

    const tool = aiToolsByName[call.name];
    if (tool?.mutating) {
      const summary = summarizeTool(call.name, inputArgs(call), deps.getState());
      if ('error' in summary) {
        // Bad arguments: tell the model without bothering the user
        results = [...results, toolResult(call, summary)];
        continue;
      }
      return {
        results,
        toolCallsUsed,
        pending: {
          call,
          summary: summary.summary,
          remainingCalls: calls.slice(i + 1),
          results,
          toolCallsUsed,
        },
      };
    }

    deps.onLine({ kind: 'activity', text: activityLine(call, deps.getState()) });
    const result = await runTool(call.name, inputArgs(call), deps.getState, deps.dispatch);
    results = [...results, toolResult(call, result)];
  }
  return { results, toolCallsUsed };
}

/** Keep calling the model until it answers with text, needs confirmation, or hits the limit. */
async function continueTurn(
  deps: AgentDeps,
  conversation: Conversation,
  toolCallsUsed: number,
): Promise<TurnResult> {
  let announcedFallback = false;
  while (true) {
    // Out of tool calls: ask for a final answer with tools turned off
    const final = toolCallsUsed >= MAX_TOOL_CALLS_PER_MESSAGE;
    let response: ChatResponse;
    try {
      response = await callModel(deps, conversation, final);
    } catch (e) {
      deps.onLine({ kind: 'error', text: errorMessage(e) });
      return { conversation };
    }

    if (response.provider === 'gemini' && !announcedFallback) {
      announcedFallback = true;
      deps.onLine({
        kind: 'activity',
        text: `${response.fallbackReason ?? 'Claude unavailable'}, using Gemini`,
      });
    }
    if (response.stop_reason === 'refusal') {
      // A declined response isn't added to the history
      deps.onLine({
        kind: 'error',
        text: 'Claude declined this request. Try rephrasing it, or start a new chat.',
      });
      return { conversation };
    }

    conversation = {
      ...conversation,
      geminiSignatures: { ...conversation.geminiSignatures, ...response.geminiSignatures },
    };
    if (response.content.length) {
      // Append the whole turn unchanged, thinking blocks included
      conversation = append(conversation, { role: 'assistant', content: response.content });
    }

    const text = response.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('')
      .trim();
    if (text) {
      deps.onLine({ kind: 'model', text });
    }

    const calls = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (!calls.length) {
      return { conversation };
    }

    if (final) {
      // Tools were off, so this shouldn't happen. Answer the calls so the
      // history stays valid, then stop.
      const results = calls.map((call) =>
        toolResult(call, { error: 'Tool call limit reached for this message.' }),
      );
      deps.onLine({
        kind: 'error',
        text: `Stopped after ${MAX_TOOL_CALLS_PER_MESSAGE} tool calls. Try a more specific question.`,
      });
      return { conversation: append(conversation, { role: 'user', content: results }) };
    }

    const result = await runCalls(deps, calls, [], toolCallsUsed);
    if (result.pending) {
      return { conversation, pending: result.pending };
    }
    toolCallsUsed = result.toolCallsUsed;
    conversation = append(conversation, { role: 'user', content: result.results });
  }
}

/** Send a new user message and run the agent until it answers or needs confirmation. */
export async function sendUserMessage(
  deps: AgentDeps,
  conversation: Conversation,
  text: string,
): Promise<TurnResult> {
  deps.onLine({ kind: 'user', text });
  // Consecutive user messages are fine (Claude merges them), so after an
  // error this just adds another one rather than editing the last.
  return continueTurn(deps, append(conversation, { role: 'user', content: text }), 0);
}

/** Run (or cancel) a pending action, then let the model continue. */
export async function resolvePendingAction(
  deps: AgentDeps,
  conversation: Conversation,
  pending: PendingAction,
  confirmed: boolean,
): Promise<TurnResult> {
  const { call } = pending;
  let result: ToolResult;
  if (confirmed) {
    deps.onLine({ kind: 'activity', text: `Confirmed: ${pending.summary}` });
    result = await runTool(call.name, inputArgs(call), deps.getState, deps.dispatch);
    if (typeof result.error === 'string') {
      deps.onLine({ kind: 'error', text: result.error });
    }
  } else {
    deps.onLine({ kind: 'activity', text: `Cancelled: ${pending.summary}` });
    result = { cancelled: true };
  }

  const results = [...pending.results, toolResult(call, result)];
  const rest = await runCalls(deps, pending.remainingCalls, results, pending.toolCallsUsed);
  if (rest.pending) {
    return { conversation, pending: rest.pending };
  }
  return continueTurn(
    deps,
    append(conversation, { role: 'user', content: rest.results }),
    rest.toolCallsUsed,
  );
}
