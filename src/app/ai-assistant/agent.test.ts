import { jest } from '@jest/globals';
import { RootState } from 'app/store/types';
import {
  AgentDeps,
  ChatLine,
  GeminiContent,
  MAX_TOOL_CALLS_PER_MESSAGE,
  RATE_LIMIT_MESSAGE,
  resolvePendingAction,
  sendUserMessage,
  trimContents,
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

function modelReply(parts: object[]) {
  return JSON.stringify({ candidates: [{ content: { role: 'model', parts } }] });
}

function setup() {
  const lines: ChatLine[] = [];
  const dispatch = jest.fn();
  const deps: AgentDeps = {
    proxyUrl: 'https://proxy.example/',
    getState: () => state,
    dispatch,
    onLine: (line) => lines.push(line),
  };
  return { deps, lines, dispatch };
}

function sentBody(call: number) {
  return JSON.parse(fetchMock.mock.calls[call][1]!.body as string) as {
    contents: GeminiContent[];
  };
}

beforeEach(() => {
  fetchMock.resetMocks();
});

describe('agent loop', () => {
  it('runs read-only tools and sends the results back', async () => {
    fetchMock.mockResponses(
      modelReply([
        { functionCall: { id: 'a', name: 'list_characters', args: {} }, thoughtSignature: 'sig' },
      ]),
      modelReply([{ text: 'You have one Titan.' }]),
    );
    const { deps, lines } = setup();
    const result = await sendUserMessage(deps, [], 'Who am I?');

    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.example/chat');
    expect(lines.map((l) => l.kind)).toEqual(['user', 'activity', 'model']);
    expect(result.pending).toBeUndefined();

    // The model's function call part comes back with its thought signature intact
    const second = sentBody(1).contents;
    expect(second[1].parts[0].thoughtSignature).toBe('sig');
    expect(second[2].parts[0].functionResponse).toMatchObject({
      id: 'a',
      name: 'list_characters',
      response: { characters: [expect.objectContaining({ id: 'char1', className: 'Titan' })] },
    });
    expect(result.contents).toHaveLength(4);
  });

  it('stops at mutating tools and waits for confirmation', async () => {
    fetchMock.mockResponses(
      modelReply([{ functionCall: { name: 'equip_max_power', args: { characterId: 'char1' } } }]),
      modelReply([{ text: 'OK, I left your gear alone.' }]),
    );
    const { deps, lines, dispatch } = setup();
    const result = await sendUserMessage(deps, [], 'Max my power');

    expect(result.pending?.summary).toBe('Equip max power gear on Titan');
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalled();

    const after = await resolvePendingAction(deps, result.contents, result.pending!, false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(sentBody(1).contents.at(-1)!.parts[0].functionResponse?.response).toEqual({
      cancelled: true,
    });
    expect(after.pending).toBeUndefined();
    expect(lines.at(-1)).toEqual({ kind: 'model', text: 'OK, I left your gear alone.' });
  });

  it('returns invalid mutating args to the model without asking the user', async () => {
    fetchMock.mockResponses(
      modelReply([
        { functionCall: { name: 'move_item', args: { itemIndex: 'x', target: 'vault' } } },
      ]),
      modelReply([{ text: "I couldn't find that item." }]),
    );
    const { deps } = setup();
    const result = await sendUserMessage(deps, [], 'Move it');
    expect(result.pending).toBeUndefined();
    expect(sentBody(1).contents.at(-1)!.parts[0].functionResponse?.response.error).toMatch(
      /No item with index/,
    );
  });

  it(`caps tool calls at ${MAX_TOOL_CALLS_PER_MESSAGE} per message`, async () => {
    const call = modelReply([{ functionCall: { name: 'list_characters', args: {} } }]);
    fetchMock.mockResponse(call);
    const { deps, lines } = setup();
    const result = await sendUserMessage(deps, [], 'Loop forever');

    expect(fetchMock.mock.calls).toHaveLength(MAX_TOOL_CALLS_PER_MESSAGE + 1);
    expect(lines.at(-1)?.kind).toBe('error');
    // History ends with responses to every call, so the next message is valid
    expect(result.contents.at(-1)!.role).toBe('user');
  });

  it('shows a friendly message on rate limits after one retry', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    fetchMock.mockResponse(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
    const { deps, lines } = setup();
    const promise = sendUserMessage(deps, [], 'hi');
    await jest.advanceTimersByTimeAsync(2500);
    await promise;
    jest.useRealTimers();

    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(lines.at(-1)).toEqual({ kind: 'error', text: RATE_LIMIT_MESSAGE });
  });

  it('merges a new message into a dangling user turn', async () => {
    fetchMock.mockResponse(modelReply([{ text: 'hello' }]));
    const { deps } = setup();
    const contents: GeminiContent[] = [{ role: 'user', parts: [{ text: 'first' }] }];
    await sendUserMessage(deps, contents, 'second');
    expect(sentBody(0).contents).toEqual([
      { role: 'user', parts: [{ text: 'first' }, { text: 'second' }] },
    ]);
  });
});

describe('trimContents', () => {
  it('drops whole old turns to fit', () => {
    const big = 'x'.repeat(1000);
    const contents: GeminiContent[] = [
      { role: 'user', parts: [{ text: big }] },
      { role: 'model', parts: [{ functionCall: { name: 'list_characters' } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'list_characters', response: {} } }] },
      { role: 'model', parts: [{ text: big }] },
      { role: 'user', parts: [{ text: 'latest' }] },
    ];
    expect(trimContents(contents, 500)).toEqual([contents[4]]);
    expect(trimContents(contents, 100_000)).toBe(contents);
  });
});
