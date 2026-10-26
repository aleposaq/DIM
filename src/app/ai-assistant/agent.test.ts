import type Anthropic from '@anthropic-ai/sdk';
import { jest } from '@jest/globals';
import { RootState } from 'app/store/types';
import {
  AgentDeps,
  ChatLine,
  Conversation,
  emptyConversation,
  MAX_TOOL_CALLS_PER_MESSAGE,
  RATE_LIMIT_MESSAGE,
  resolvePendingAction,
  sendUserMessage,
  TOO_LONG_MESSAGE,
} from './agent';

const titan = {
  id: 'char1',
  isVault: false,
  current: true,
  className: 'Titan',
  classType: 0,
  powerLevel: 2000,
  items: [],
};

const state = { inventory: { stores: [titan] } } as unknown as RootState;

function reply(
  content: object[],
  extra: { provider?: 'claude' | 'gemini'; stop_reason?: string; fallbackReason?: string } = {},
) {
  const hasToolUse = content.some((b) => (b as { type: string }).type === 'tool_use');
  return JSON.stringify({
    provider: 'claude',
    stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
    content,
    ...extra,
  });
}

function toolUse(id: string, name: string, input: object = {}) {
  return { type: 'tool_use', id, name, input };
}

function setup() {
  const lines: ChatLine[] = [];
  const dispatch = jest.fn();
  const deps: AgentDeps = {
    proxyUrl: 'https://proxy.example/',
    proxyToken: 'secret',
    getState: () => state,
    dispatch,
    onLine: (line) => lines.push(line),
  };
  return { deps, lines, dispatch };
}

function sentBody(call: number) {
  return JSON.parse(fetchMock.mock.calls[call][1]!.body as string) as {
    system: string;
    tools: Anthropic.Beta.BetaTool[];
    messages: Anthropic.Beta.BetaMessageParam[];
    geminiSignatures: Record<string, string>;
  };
}

function lastBlock(messages: Anthropic.Beta.BetaMessageParam[]) {
  const content = messages.at(-1)!.content;
  return (Array.isArray(content) ? content.at(-1) : undefined) as
    Anthropic.Beta.BetaToolResultBlockParam | undefined;
}

beforeEach(() => {
  fetchMock.resetMocks();
});

describe('agent loop', () => {
  it('sends Claude-format requests with the access token', async () => {
    fetchMock.mockResponse(reply([{ type: 'text', text: 'Hi' }]));
    const { deps } = setup();
    await sendUserMessage(deps, emptyConversation, 'hello');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://proxy.example/chat');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    const body = sentBody(0);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.system).toMatch(/DIM search syntax/);
    expect(body.tools.map((t) => t.name)).toContain('search_items');
    expect(body.tools[0].input_schema.type).toBe('object');
  });

  it('runs read-only tools and keeps thinking blocks unchanged', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
    fetchMock.mockResponses(
      reply([thinking, toolUse('toolu_1', 'list_characters')]),
      reply([{ type: 'text', text: 'You have one Titan.' }]),
    );
    const { deps, lines } = setup();
    const result = await sendUserMessage(deps, emptyConversation, 'Who am I?');

    expect(lines.map((l) => l.kind)).toEqual(['user', 'activity', 'model']);
    expect(result.pending).toBeUndefined();

    const second = sentBody(1).messages;
    expect(second[1]).toEqual({
      role: 'assistant',
      content: [thinking, toolUse('toolu_1', 'list_characters')],
    });
    const toolResult = lastBlock(second)!;
    expect(toolResult.tool_use_id).toBe('toolu_1');
    expect(JSON.parse(toolResult.content as string)).toMatchObject({
      characters: [expect.objectContaining({ id: 'char1', className: 'Titan' })],
    });
    expect(result.conversation.messages).toHaveLength(4);
  });

  it('never edits earlier messages', async () => {
    fetchMock.mockResponses(
      reply([toolUse('toolu_1', 'list_characters')]),
      reply([{ type: 'text', text: 'Done' }]),
      reply([{ type: 'text', text: 'Again' }]),
    );
    const { deps } = setup();
    const first = await sendUserMessage(deps, emptyConversation, 'one');
    const snapshot = JSON.stringify(first.conversation.messages);
    const second = await sendUserMessage(deps, first.conversation, 'two');
    const prefix = second.conversation.messages.slice(0, first.conversation.messages.length);
    expect(JSON.stringify(prefix)).toBe(snapshot);
  });

  it('stops at mutating tools and waits for confirmation', async () => {
    fetchMock.mockResponses(
      reply([toolUse('toolu_1', 'equip_max_power', { characterId: 'char1' })]),
      reply([{ type: 'text', text: 'OK, I left your gear alone.' }]),
    );
    const { deps, lines, dispatch } = setup();
    const result = await sendUserMessage(deps, emptyConversation, 'Max my power');

    expect(result.pending?.summary).toBe('Equip max power gear on Titan');
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalled();

    const after = await resolvePendingAction(deps, result.conversation, result.pending!, false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(JSON.parse(lastBlock(sentBody(1).messages)!.content as string)).toEqual({
      cancelled: true,
    });
    expect(after.pending).toBeUndefined();
    expect(lines.at(-1)).toEqual({ kind: 'model', text: 'OK, I left your gear alone.' });
  });

  it('returns invalid mutating args to the model as an error result', async () => {
    fetchMock.mockResponses(
      reply([toolUse('toolu_1', 'move_item', { itemIndex: 'x', target: 'vault' })]),
      reply([{ type: 'text', text: "I couldn't find that item." }]),
    );
    const { deps } = setup();
    const result = await sendUserMessage(deps, emptyConversation, 'Move it');
    expect(result.pending).toBeUndefined();
    const toolResult = lastBlock(sentBody(1).messages)!;
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/No item with index/);
  });

  it(`caps tool calls at ${MAX_TOOL_CALLS_PER_MESSAGE} per message`, async () => {
    let n = 0;
    fetchMock.mockResponse(async () => reply([toolUse(`toolu_${n++}`, 'list_characters')]));
    const { deps, lines } = setup();
    const result = await sendUserMessage(deps, emptyConversation, 'Loop forever');

    expect(fetchMock.mock.calls).toHaveLength(MAX_TOOL_CALLS_PER_MESSAGE + 1);
    expect(lines.at(-1)?.kind).toBe('error');
    // Every tool_use has a tool_result, so the next message is valid
    expect(result.conversation.messages.at(-1)!.role).toBe('user');
  });

  it('notes a Gemini fallback once and keeps its signatures', async () => {
    fetchMock.mockResponses(
      JSON.stringify({
        provider: 'gemini',
        stop_reason: 'tool_use',
        fallbackReason: 'Claude rate limit hit',
        content: [toolUse('toolu_gemini_1', 'list_characters')],
        geminiSignatures: { toolu_gemini_1: 'gem-sig' },
      }),
      reply([{ type: 'text', text: 'Hi' }], {
        provider: 'gemini',
        fallbackReason: 'Claude rate limit hit',
      }),
    );
    const { deps, lines } = setup();
    const result = await sendUserMessage(deps, emptyConversation, 'Who am I?');
    expect(lines.filter((l) => l.text === 'Claude rate limit hit, using Gemini')).toHaveLength(1);
    expect(sentBody(1).geminiSignatures).toEqual({ toolu_gemini_1: 'gem-sig' });
    expect(result.conversation.geminiSignatures).toEqual({ toolu_gemini_1: 'gem-sig' });
  });

  it("doesn't add a refused response to the history", async () => {
    fetchMock.mockResponse(reply([], { stop_reason: 'refusal' }));
    const { deps, lines } = setup();
    const result = await sendUserMessage(deps, emptyConversation, 'hi');
    expect(result.conversation.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(lines.at(-1)?.text).toMatch(/declined/);
  });

  it('shows friendly messages for proxy errors', async () => {
    const { deps, lines } = setup();
    fetchMock.mockResponseOnce(JSON.stringify({ error: { message: 'x' } }), { status: 429 });
    await sendUserMessage(deps, emptyConversation, 'hi');
    expect(lines.at(-1)).toEqual({ kind: 'error', text: RATE_LIMIT_MESSAGE });

    fetchMock.mockResponseOnce(JSON.stringify({ error: { message: 'x' } }), { status: 401 });
    await sendUserMessage(deps, emptyConversation, 'hi');
    expect(lines.at(-1)?.text).toMatch(/access token/);
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it('adds a new user message after an error instead of editing the last one', async () => {
    fetchMock.mockResponse(reply([{ type: 'text', text: 'hello' }]));
    const { deps } = setup();
    const conversation: Conversation = {
      messages: [{ role: 'user', content: 'first' }],
      geminiSignatures: {},
    };
    await sendUserMessage(deps, conversation, 'second');
    expect(sentBody(0).messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('asks for a new chat instead of trimming a long conversation', async () => {
    const { deps, lines } = setup();
    const conversation: Conversation = {
      messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }],
      geminiSignatures: {},
    };
    await sendUserMessage(deps, conversation, 'more');
    expect(fetchMock.mock.calls).toHaveLength(0);
    expect(lines.at(-1)).toEqual({ kind: 'error', text: TOO_LONG_MESSAGE });
  });
});
