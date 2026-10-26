import { allItemsSelector } from 'app/inventory/selectors';
import { DimThunkDispatch, RootState } from 'app/store/types';
import { errorMessage } from 'app/utils/errors';
import { delay } from 'app/utils/promises';
import memoizeOne from 'memoize-one';
import { searchCheatSheet } from './search-cheat-sheet';
import { aiTools, aiToolsByName, runTool, summarizeTool, ToolArgs, ToolResult } from './tools';

/** Max tool calls the model may make while answering one user message. */
export const MAX_TOOL_CALLS_PER_MESSAGE = 8;

/** Stay under the proxy Worker's 200 KB body cap. */
const MAX_REQUEST_BYTES = 180 * 1024;

export const RATE_LIMIT_MESSAGE = 'Free-tier rate limit hit, try again in a minute.';

//
// Gemini generateContent types (just the parts we use)
//

export interface FunctionCall {
  id?: string;
  name: string;
  args?: ToolArgs;
}

export interface GeminiPart {
  text?: string;
  /** Thought summaries, which we don't show. */
  thought?: boolean;
  /** Opaque, must be sent back exactly as received. */
  thoughtSignature?: string;
  functionCall?: FunctionCall;
  functionResponse?: { id?: string; name: string; response: ToolResult };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GenerateContentResponse {
  candidates?: { content?: GeminiContent; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

//
// Agent state passed back and forth with the UI
//

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
  call: FunctionCall;
  summary: string;
  /** Other calls from the same model response that haven't run yet. */
  remainingCalls: FunctionCall[];
  /** functionResponse parts collected so far for that model response. */
  responses: GeminiPart[];
  toolCallsUsed: number;
}

export interface TurnResult {
  contents: GeminiContent[];
  pending?: PendingAction;
}

export interface AgentDeps {
  /** Base URL of the proxy Worker. */
  proxyUrl: string;
  getState: () => RootState;
  dispatch: DimThunkDispatch;
  /** Called for each new line to show in the transcript. */
  onLine: (line: ChatLine) => void;
}

const systemInstruction = memoizeOne(() => ({
  parts: [
    {
      text: [
        "You manage a Destiny 2 player's inventory through DIM. Use tools; never invent item names or ids. Use DIM search syntax in search_items.",
        'Item indexes come from search_items. Character ids come from list_characters. Loadout ids come from list_loadouts.',
        'Tools that move, equip, apply or save ask the player to confirm first. If a result says cancelled, acknowledge it and do not retry.',
        'Keep answers short. Refer to items by name, never by index.',
        '',
        searchCheatSheet(),
      ].join('\n'),
    },
  ],
}));

const toolDeclarations = memoizeOne(() => [
  { functionDeclarations: aiTools.map((t) => t.declaration) },
]);

class ProxyError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

function chatUrl(proxyUrl: string) {
  const base = proxyUrl.trim().replace(/\/+$/, '');
  return base.endsWith('/chat') ? base : `${base}/chat`;
}

/**
 * Drop the oldest turns until the request fits under the Worker's size cap. A
 * turn starts at a user message with text, so we never split a function call
 * from its response.
 */
export function trimContents(contents: GeminiContent[], maxBytes = MAX_REQUEST_BYTES) {
  let trimmed = contents;
  const size = (c: GeminiContent[]) => new TextEncoder().encode(JSON.stringify(c)).length;
  while (size(trimmed) > maxBytes) {
    const nextTurn = trimmed.findIndex(
      (c, i) => i > 0 && c.role === 'user' && c.parts.some((p) => p.text !== undefined),
    );
    if (nextTurn <= 0) {
      break;
    }
    trimmed = trimmed.slice(nextTurn);
  }
  return trimmed;
}

async function callModel(proxyUrl: string, contents: GeminiContent[]): Promise<GeminiContent> {
  const body = JSON.stringify({
    contents: trimContents(contents),
    tools: toolDeclarations(),
    systemInstruction: systemInstruction(),
  });

  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(chatUrl(proxyUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (e) {
      throw new ProxyError(`Could not reach the AI proxy: ${errorMessage(e)}`);
    }
    // Retry a rate limit once, then give up
    if (response.status === 429 && attempt === 0) {
      await delay(2000);
      continue;
    }
    break;
  }
  if (!response) {
    throw new ProxyError('No response from the AI proxy');
  }

  if (response.status === 429) {
    throw new ProxyError(RATE_LIMIT_MESSAGE, 429);
  }
  let json: GenerateContentResponse & { error?: { message?: string } };
  try {
    json = (await response.json()) as typeof json;
  } catch {
    throw new ProxyError(`AI proxy returned HTTP ${response.status}`, response.status);
  }
  if (!response.ok) {
    throw new ProxyError(
      json.error?.message ?? `AI proxy returned HTTP ${response.status}`,
      response.status,
    );
  }

  const candidate = json.candidates?.[0];
  if (!candidate?.content?.parts?.length) {
    const reason = json.promptFeedback?.blockReason ?? candidate?.finishReason ?? 'no content';
    throw new ProxyError(`The model didn't answer (${reason})`);
  }
  // Keep the content exactly as received so thought signatures survive.
  return { ...candidate.content, role: 'model' };
}

/** A transcript line for a read-only tool call, e.g. "Searched: is:exotic is:void". */
function activityLine(call: FunctionCall, state: RootState) {
  const args = call.args ?? {};
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
    case 'list_loadouts':
      return args.classType ? `Listed ${str(args.classType)} loadouts` : 'Listed loadouts';
    default:
      return `Ran ${call.name}`;
  }
}

function functionResponse(call: FunctionCall, response: ToolResult): GeminiPart {
  return {
    functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response },
  };
}

/**
 * Run the function calls from one model response in order. Stops at the first
 * mutating call and returns it as a pending action.
 */
async function runCalls(
  deps: AgentDeps,
  calls: FunctionCall[],
  responses: GeminiPart[],
  toolCallsUsed: number,
): Promise<{ responses: GeminiPart[]; toolCallsUsed: number; pending?: PendingAction }> {
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    toolCallsUsed++;
    if (toolCallsUsed > MAX_TOOL_CALLS_PER_MESSAGE) {
      responses = [
        ...responses,
        functionResponse(call, {
          error: 'Tool call limit reached for this message. Answer with what you have.',
        }),
      ];
      continue;
    }

    const tool = aiToolsByName[call.name];
    if (tool?.mutating) {
      const summary = summarizeTool(call.name, call.args ?? {}, deps.getState());
      if ('error' in summary) {
        // Bad arguments: tell the model without bothering the user
        responses = [...responses, functionResponse(call, summary)];
        continue;
      }
      return {
        responses,
        toolCallsUsed,
        pending: {
          call,
          summary: summary.summary,
          remainingCalls: calls.slice(i + 1),
          responses,
          toolCallsUsed,
        },
      };
    }

    deps.onLine({ kind: 'activity', text: activityLine(call, deps.getState()) });
    const result = await runTool(call.name, call.args ?? {}, deps.getState, deps.dispatch);
    responses = [...responses, functionResponse(call, result)];
  }
  return { responses, toolCallsUsed };
}

/** Keep calling the model until it answers with text, needs confirmation, or hits the limit. */
async function continueTurn(
  deps: AgentDeps,
  contents: GeminiContent[],
  toolCallsUsed: number,
): Promise<TurnResult> {
  while (true) {
    let modelContent: GeminiContent;
    try {
      modelContent = await callModel(deps.proxyUrl, contents);
    } catch (e) {
      deps.onLine({ kind: 'error', text: errorMessage(e) });
      return { contents };
    }
    contents = [...contents, modelContent];

    const text = modelContent.parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim();
    if (text) {
      deps.onLine({ kind: 'model', text });
    }

    const calls = modelContent.parts.flatMap((p) => (p.functionCall ? [p.functionCall] : []));
    if (!calls.length) {
      return { contents };
    }

    if (toolCallsUsed >= MAX_TOOL_CALLS_PER_MESSAGE) {
      // Answer the calls so the history stays valid, then stop.
      const responses = calls.map((call) =>
        functionResponse(call, { error: 'Tool call limit reached for this message.' }),
      );
      deps.onLine({
        kind: 'error',
        text: `Stopped after ${MAX_TOOL_CALLS_PER_MESSAGE} tool calls. Try a more specific question.`,
      });
      return { contents: [...contents, { role: 'user', parts: responses }] };
    }

    const result = await runCalls(deps, calls, [], toolCallsUsed);
    if (result.pending) {
      return { contents, pending: result.pending };
    }
    toolCallsUsed = result.toolCallsUsed;
    contents = [...contents, { role: 'user', parts: result.responses }];
  }
}

/** Send a new user message and run the agent until it answers or needs confirmation. */
export async function sendUserMessage(
  deps: AgentDeps,
  contents: GeminiContent[],
  text: string,
): Promise<TurnResult> {
  deps.onLine({ kind: 'user', text });
  const last = contents.at(-1);
  // If the last turn ended on our side (an error or the tool limit), add to it
  // rather than sending two user contents in a row.
  const next: GeminiContent[] =
    last?.role === 'user'
      ? [...contents.slice(0, -1), { role: 'user', parts: [...last.parts, { text }] }]
      : [...contents, { role: 'user', parts: [{ text }] }];
  return continueTurn(deps, next, 0);
}

/** Run (or cancel) a pending action, then let the model continue. */
export async function resolvePendingAction(
  deps: AgentDeps,
  contents: GeminiContent[],
  pending: PendingAction,
  confirmed: boolean,
): Promise<TurnResult> {
  const { call } = pending;
  let result: ToolResult;
  if (confirmed) {
    deps.onLine({ kind: 'activity', text: `Confirmed: ${pending.summary}` });
    result = await runTool(call.name, call.args ?? {}, deps.getState, deps.dispatch);
    if (typeof result.error === 'string') {
      deps.onLine({ kind: 'error', text: result.error });
    }
  } else {
    deps.onLine({ kind: 'activity', text: `Cancelled: ${pending.summary}` });
    result = { cancelled: true };
  }

  const responses = [...pending.responses, functionResponse(call, result)];
  const rest = await runCalls(deps, pending.remainingCalls, responses, pending.toolCallsUsed);
  if (rest.pending) {
    return { contents, pending: rest.pending };
  }
  return continueTurn(
    deps,
    [...contents, { role: 'user', parts: rest.responses }],
    rest.toolCallsUsed,
  );
}
