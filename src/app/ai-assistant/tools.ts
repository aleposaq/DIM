import { DimItem } from 'app/inventory/item-types';
import { moveItemTo } from 'app/inventory/move-item';
import {
  allItemsSelector,
  currentStoreSelector,
  storesSelector,
  vaultSelector,
} from 'app/inventory/selectors';
import { DimStore } from 'app/inventory/store-types';
import { getStore } from 'app/inventory/stores-helpers';
import { maxLightLoadout } from 'app/loadout-drawer/auto-loadouts';
import { applyLoadout } from 'app/loadout-drawer/loadout-apply';
import {
  convertToLoadoutItem,
  newLoadout,
  newLoadoutFromEquipped,
} from 'app/loadout-drawer/loadout-utils';
import { updateLoadout } from 'app/loadout/actions';
import { applyInGameLoadout } from 'app/loadout/ingame/ingame-loadout-apply';
import { allInGameLoadoutsSelector } from 'app/loadout/ingame/selectors';
import { InGameLoadout, Loadout } from 'app/loadout/loadout-types';
import { loadoutsSelector } from 'app/loadout/loadouts-selector';
import { filterFactorySelector, validateQuerySelector } from 'app/search/items/item-search-filter';
import { DimThunkDispatch, RootState } from 'app/store/types';
import { isClassCompatible } from 'app/utils/item-utils';
import { DestinyClass } from 'bungie-api-ts/destiny2';

/** Max number of item summaries returned from a single search_items call. */
export const MAX_SEARCH_RESULTS = 25;

/** A JSON-schema-ish parameter description in the subset Gemini accepts. */
export interface ToolSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, ToolSchema>;
  required?: string[];
  items?: ToolSchema;
  enum?: string[];
}

/** A Gemini functionDeclaration. */
export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: ToolSchema;
}

/** What a tool sends back to the model. Must be a JSON object. */
export type ToolResult = Record<string, unknown>;

export type ToolArgs = Record<string, unknown>;

export interface AiTool {
  declaration: FunctionDeclaration;
  /** Mutating tools need the user to confirm before they run. */
  mutating: boolean;
  /**
   * For mutating tools: a human-readable summary of what the tool will do,
   * built from real item and store names, or an error if the args are invalid.
   */
  summarize?: (args: ToolArgs, state: RootState) => { summary: string } | { error: string };
  execute: (
    args: ToolArgs,
    getState: () => RootState,
    dispatch: DimThunkDispatch,
  ) => Promise<ToolResult>;
}

class ToolError extends Error {}

//
// Argument helpers. These throw ToolError, which runTool turns into { error }.
//

function stringArg(args: ToolArgs, name: string, required: true): string;
function stringArg(args: ToolArgs, name: string, required?: false): string | undefined;
function stringArg(args: ToolArgs, name: string, required = false) {
  const value = args[name];
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new ToolError(`Missing required argument "${name}"`);
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ToolError(`Argument "${name}" must be a string`);
  }
  return value.trim();
}

function stringArrayArg(args: ToolArgs, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new ToolError(`Argument "${name}" must be a list of strings`);
  }
  return value;
}

function boolArg(args: ToolArgs, name: string) {
  const value = args[name];
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new ToolError(`Argument "${name}" must be true or false`);
  }
  return value;
}

const classTypesByName: Record<string, DestinyClass> = {
  titan: DestinyClass.Titan,
  hunter: DestinyClass.Hunter,
  warlock: DestinyClass.Warlock,
  any: DestinyClass.Unknown,
};

const classNames: Partial<Record<DestinyClass, string>> = {
  [DestinyClass.Titan]: 'Titan',
  [DestinyClass.Hunter]: 'Hunter',
  [DestinyClass.Warlock]: 'Warlock',
  [DestinyClass.Unknown]: 'Any class',
};

function classTypeArg(args: ToolArgs, name: string) {
  const value = stringArg(args, name);
  if (value === undefined) {
    return undefined;
  }
  const classType = classTypesByName[value.toLowerCase()];
  if (classType === undefined) {
    throw new ToolError(`Argument "${name}" must be one of titan, hunter, warlock, any`);
  }
  return classType;
}

function findItem(state: RootState, itemIndex: string) {
  const item = allItemsSelector(state).find((i) => i.index === itemIndex);
  if (!item) {
    throw new ToolError(
      `No item with index "${itemIndex}". Use search_items to find item indexes.`,
    );
  }
  return item;
}

/** A character by id, or the current character when no id is given. */
function findCharacter(state: RootState, characterId: string | undefined) {
  const store = characterId
    ? getStore(storesSelector(state), characterId)
    : currentStoreSelector(state);
  if (!store || store.isVault) {
    throw new ToolError(
      characterId
        ? `No character with id "${characterId}". Use list_characters to get ids.`
        : 'No current character found',
    );
  }
  return store;
}

/** A character by id, or the vault when target is "vault". */
function findTarget(state: RootState, target: string) {
  if (target.toLowerCase() === 'vault') {
    const vault = vaultSelector(state);
    if (!vault) {
      throw new ToolError('No vault found');
    }
    return vault;
  }
  return findCharacter(state, target);
}

function findLoadout(state: RootState, loadoutId: string): Loadout | InGameLoadout {
  const loadout = loadoutId.startsWith('ingame')
    ? allInGameLoadoutsSelector(state).find((l) => l.id === loadoutId)
    : loadoutsSelector(state).find((l) => l.id === loadoutId);
  if (!loadout) {
    throw new ToolError(`No loadout with id "${loadoutId}". Use list_loadouts to get ids.`);
  }
  return loadout;
}

function storeName(store: DimStore) {
  return store.isVault ? 'vault' : store.className;
}

function ownerName(state: RootState, item: DimItem) {
  const store = getStore(storesSelector(state), item.owner);
  return store ? storeName(store) : item.owner;
}

function checkClass(item: DimItem, store: DimStore) {
  if (!isClassCompatible(item.classType, store.classType)) {
    throw new ToolError(`${item.name} can't be equipped by a ${store.className}`);
  }
}

//
// Item summaries
//

/** Names of the perks currently plugged into an item, in socket order, without duplicates. */
export function perkNames(item: DimItem): string[] {
  if (!item.sockets) {
    return [];
  }
  const names = new Set<string>();
  for (const socket of item.sockets.allSockets) {
    const name = socket.plugged?.plugDef.displayProperties.name;
    if (socket.isPerk && name) {
      names.add(name);
    }
  }
  return [...names];
}

export interface ItemSummary {
  index: string;
  name: string;
  type: string;
  tier: string;
  power: number;
  element?: string;
  slot: string;
  owner: string;
  equipped: boolean;
  locked: boolean;
  perks: string[];
}

/**
 * A compact summary of an item for the model. `owner` is the class name of the
 * character holding it, or "vault".
 */
export function summarizeItem(item: DimItem, owner: string): ItemSummary {
  return {
    index: item.index,
    name: item.name,
    type: item.typeName,
    tier: item.rarity,
    power: item.power,
    element: item.element?.displayProperties.name || undefined,
    slot: item.bucket.name,
    owner,
    equipped: item.equipped,
    locked: item.locked,
    perks: perkNames(item).slice(0, 4),
  };
}

function itemDetails(state: RootState, item: DimItem): ToolResult {
  return {
    ...summarizeItem(item, ownerName(state, item)),
    perks: perkNames(item),
    stats: item.stats
      ?.filter((s) => s.displayProperties.name)
      .map((s) => ({ name: s.displayProperties.name, value: s.value })),
    masterwork: item.masterwork,
    crafted: item.crafted || false,
    classType: classNames[item.classType] ?? 'Any class',
  };
}

function loadoutClassName(loadout: Loadout | InGameLoadout, state: RootState) {
  if ('characterId' in loadout) {
    const store = getStore(storesSelector(state), loadout.characterId);
    return store?.className ?? 'Unknown';
  }
  return classNames[loadout.classType] ?? 'Any class';
}

//
// Tools
//

const listCharacters: AiTool = {
  mutating: false,
  declaration: {
    name: 'list_characters',
    description:
      "List the player's characters and vault, with ids to pass to other tools. Call this before acting on a specific character.",
    parameters: { type: 'object', properties: {} },
  },
  execute: async (_args, getState) => {
    const state = getState();
    const current = currentStoreSelector(state);
    return {
      characters: storesSelector(state).map((store) => ({
        id: store.id,
        className: store.isVault ? 'Vault' : store.className,
        power: store.isVault ? undefined : store.powerLevel,
        isVault: store.isVault,
        isCurrent: store.id === current?.id,
      })),
    };
  },
};

const searchItemsTool: AiTool = {
  mutating: false,
  declaration: {
    name: 'search_items',
    description: `Search the player's items with DIM search syntax, e.g. "is:weapon is:exotic is:void". Returns at most ${MAX_SEARCH_RESULTS} compact item summaries, highest power first, plus the total number of matches.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A DIM search query' },
      },
      required: ['query'],
    },
  },
  execute: async (args, getState) => {
    const state = getState();
    const query = stringArg(args, 'query', true);
    if (!validateQuerySelector(state)(query).valid) {
      return {
        error: `"${query}" is not a valid DIM search. Check the filter names in the cheat sheet.`,
      };
    }
    const filter = filterFactorySelector(state)(query);
    const matches = allItemsSelector(state)
      .filter((i) => filter(i))
      .sort((a, b) => b.power - a.power);
    if (matches.length === 0) {
      return {
        items: [],
        total: 0,
        hint: 'No items matched. Try a broader query with fewer filters.',
      };
    }
    const stores = storesSelector(state);
    return {
      items: matches.slice(0, MAX_SEARCH_RESULTS).map((item) => {
        const store = getStore(stores, item.owner);
        return summarizeItem(item, store ? storeName(store) : item.owner);
      }),
      total: matches.length,
    };
  },
};

const describeItem: AiTool = {
  mutating: false,
  declaration: {
    name: 'describe_item',
    description: 'Get full details for one item: stats, all perks, masterwork and crafted state.',
    parameters: {
      type: 'object',
      properties: {
        itemIndex: { type: 'string', description: 'The item index from search_items' },
      },
      required: ['itemIndex'],
    },
  },
  execute: async (args, getState) => {
    const state = getState();
    return itemDetails(state, findItem(state, stringArg(args, 'itemIndex', true)));
  },
};

const listLoadouts: AiTool = {
  mutating: false,
  declaration: {
    name: 'list_loadouts',
    description: "List the player's DIM loadouts and in-game loadouts, optionally for one class.",
    parameters: {
      type: 'object',
      properties: {
        classType: {
          type: 'string',
          enum: ['titan', 'hunter', 'warlock', 'any'],
          description: 'Only list loadouts usable by this class',
        },
      },
    },
  },
  execute: async (args, getState) => {
    const state = getState();
    const classType = classTypeArg(args, 'classType');
    const stores = storesSelector(state);
    const matchesClass = (c: DestinyClass) =>
      classType === undefined ||
      classType === DestinyClass.Unknown ||
      isClassCompatible(c, classType);

    const dimLoadouts = loadoutsSelector(state)
      .filter((l) => matchesClass(l.classType))
      .map((l) => ({
        id: l.id,
        name: l.name,
        className: loadoutClassName(l, state),
        itemCount: l.items.length,
        notes: l.notes ? l.notes.slice(0, 200) : undefined,
        inGame: false,
      }));
    const inGameLoadouts = allInGameLoadoutsSelector(state)
      .filter((l) => {
        const store = getStore(stores, l.characterId);
        return store && matchesClass(store.classType);
      })
      .map((l) => ({
        id: l.id,
        name: l.name,
        className: loadoutClassName(l, state),
        itemCount: l.items.filter((i) => i.itemInstanceId !== '0').length,
        inGame: true,
      }));
    return { loadouts: [...dimLoadouts, ...inGameLoadouts] };
  },
};

const moveItem: AiTool = {
  mutating: true,
  declaration: {
    name: 'move_item',
    description: 'Move an item to a character or the vault, optionally equipping it.',
    parameters: {
      type: 'object',
      properties: {
        itemIndex: { type: 'string', description: 'The item index from search_items' },
        target: { type: 'string', description: 'A character id from list_characters, or "vault"' },
        equip: { type: 'boolean', description: 'Equip the item after moving it' },
      },
      required: ['itemIndex', 'target'],
    },
  },
  summarize: (args, state) => {
    const item = findItem(state, stringArg(args, 'itemIndex', true));
    const target = findTarget(state, stringArg(args, 'target', true));
    const equip = boolArg(args, 'equip');
    if (equip && target.isVault) {
      throw new ToolError("Items can't be equipped in the vault");
    }
    if (equip) {
      checkClass(item, target);
      return { summary: `Equip ${item.name} on ${storeName(target)}` };
    }
    return { summary: `Move ${item.name} to ${storeName(target)}` };
  },
  execute: async (args, getState, dispatch) => {
    const state = getState();
    const item = findItem(state, stringArg(args, 'itemIndex', true));
    const target = findTarget(state, stringArg(args, 'target', true));
    const equip = boolArg(args, 'equip') && !target.isVault;
    await dispatch(moveItemTo(item, target, equip, item.amount));
    return {
      result: `${equip ? 'Equipped' : 'Moved'} ${item.name} ${equip ? 'on' : 'to'} ${storeName(target)}`,
    };
  },
};

function equipItemsLoadout(state: RootState, args: ToolArgs) {
  const store = findCharacter(state, stringArg(args, 'characterId'));
  const indices = stringArrayArg(args, 'itemIndices');
  if (!indices.length) {
    throw new ToolError('itemIndices must list at least one item');
  }
  const items = indices.map((index) => findItem(state, index));
  for (const item of items) {
    checkClass(item, store);
  }
  const loadout = newLoadout(
    'AI Assistant',
    items.map((i) => convertToLoadoutItem(i, true)),
    store.classType,
  );
  return { store, items, loadout };
}

const equipItems: AiTool = {
  mutating: true,
  declaration: {
    name: 'equip_items',
    description:
      'Equip one or more items on a character, moving them there first if needed. Can be undone from DIM.',
    parameters: {
      type: 'object',
      properties: {
        itemIndices: {
          type: 'array',
          items: { type: 'string' },
          description: 'Item indexes from search_items',
        },
        characterId: {
          type: 'string',
          description: 'A character id from list_characters. Defaults to the current character.',
        },
      },
      required: ['itemIndices'],
    },
  },
  summarize: (args, state) => {
    const { store, items } = equipItemsLoadout(state, args);
    return { summary: `Equip ${items.map((i) => i.name).join(', ')} on ${store.className}` };
  },
  execute: async (args, getState, dispatch) => {
    const { store, items, loadout } = equipItemsLoadout(getState(), args);
    await dispatch(applyLoadout(store, loadout, { allowUndo: true }));
    return { result: `Equipped ${items.map((i) => i.name).join(', ')} on ${store.className}` };
  },
};

function loadoutTarget(state: RootState, args: ToolArgs) {
  const loadout = findLoadout(state, stringArg(args, 'loadoutId', true));
  // In-game loadouts always apply to the character they belong to
  const store =
    'characterId' in loadout
      ? findCharacter(state, loadout.characterId)
      : findCharacter(state, stringArg(args, 'characterId'));
  if (!('characterId' in loadout) && !isClassCompatible(loadout.classType, store.classType)) {
    throw new ToolError(`Loadout "${loadout.name}" is not for a ${store.className}`);
  }
  return { loadout, store };
}

const applyLoadoutTool: AiTool = {
  mutating: true,
  declaration: {
    name: 'apply_loadout',
    description:
      'Apply a DIM or in-game loadout to a character. In-game loadouts always apply to their own character.',
    parameters: {
      type: 'object',
      properties: {
        loadoutId: { type: 'string', description: 'A loadout id from list_loadouts' },
        characterId: {
          type: 'string',
          description: 'A character id from list_characters. Defaults to the current character.',
        },
      },
      required: ['loadoutId'],
    },
  },
  summarize: (args, state) => {
    const { loadout, store } = loadoutTarget(state, args);
    return { summary: `Apply loadout "${loadout.name}" to ${store.className}` };
  },
  execute: async (args, getState, dispatch) => {
    const { loadout, store } = loadoutTarget(getState(), args);
    if ('characterId' in loadout) {
      await dispatch(applyInGameLoadout(loadout));
    } else {
      await dispatch(applyLoadout(store, loadout, { allowUndo: true }));
    }
    return { result: `Applied loadout "${loadout.name}" to ${store.className}` };
  },
};

function buildNewLoadout(state: RootState, args: ToolArgs) {
  const name = stringArg(args, 'name', true);
  const notes = stringArg(args, 'notes');
  const fromCharacterId = stringArg(args, 'fromEquippedCharacterId');
  const itemIndices = stringArrayArg(args, 'itemIndices');
  const equipIndices = stringArrayArg(args, 'equipIndices');

  let loadout: Loadout;
  if (fromCharacterId) {
    // Start from what the character is wearing, including subclass and mods
    const store = findCharacter(state, fromCharacterId);
    loadout = { ...newLoadoutFromEquipped(name, store), id: globalThis.crypto.randomUUID() };
  } else {
    const classType = classTypeArg(args, 'classType');
    if (classType === undefined) {
      throw new ToolError('classType is required unless fromEquippedCharacterId is set');
    }
    if (!itemIndices.length && !equipIndices.length) {
      throw new ToolError('List at least one item in itemIndices or equipIndices');
    }
    loadout = newLoadout(name, [], classType);
  }

  const extraIndices = [...new Set([...itemIndices, ...equipIndices])];
  const items = extraIndices.map((index) => findItem(state, index));
  for (const item of items) {
    if (!isClassCompatible(item.classType, loadout.classType)) {
      throw new ToolError(`${item.name} doesn't fit a ${classNames[loadout.classType]} loadout`);
    }
    // Don't add the same item twice when starting from equipped
    if (!loadout.items.some((li) => li.id === item.id && li.hash === item.hash)) {
      loadout.items.push(convertToLoadoutItem(item, equipIndices.includes(item.index)));
    }
  }
  if (notes) {
    loadout.notes = notes;
  }
  return { loadout, items };
}

const createLoadout: AiTool = {
  mutating: true,
  declaration: {
    name: 'create_loadout',
    description:
      'Save a new DIM loadout. To save what a character is wearing (including subclass and mods), set fromEquippedCharacterId.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Loadout name' },
        classType: {
          type: 'string',
          enum: ['titan', 'hunter', 'warlock', 'any'],
          description: 'Class the loadout is for. Ignored with fromEquippedCharacterId.',
        },
        itemIndices: {
          type: 'array',
          items: { type: 'string' },
          description: 'Item indexes to include, not equipped',
        },
        equipIndices: {
          type: 'array',
          items: { type: 'string' },
          description: 'Item indexes to include and equip',
        },
        notes: { type: 'string', description: 'Optional loadout notes' },
        fromEquippedCharacterId: {
          type: 'string',
          description: "Start from this character's equipped gear, subclass and mods",
        },
      },
      required: ['name'],
    },
  },
  summarize: (args, state) => {
    const { loadout, items } = buildNewLoadout(state, args);
    const fromCharacterId = stringArg(args, 'fromEquippedCharacterId');
    const source = fromCharacterId
      ? `what ${findCharacter(state, fromCharacterId).className} is wearing`
      : `${loadout.items.length} items`;
    const extra = fromCharacterId && items.length ? ` plus ${items.length} more items` : '';
    return {
      summary: `Save ${source}${extra} as ${classNames[loadout.classType]} loadout "${loadout.name}"`,
    };
  },
  execute: async (args, getState, dispatch) => {
    const { loadout } = buildNewLoadout(getState(), args);
    dispatch(updateLoadout(loadout));
    return {
      result: `Saved loadout "${loadout.name}" with ${loadout.items.length} items`,
      loadoutId: loadout.id,
    };
  },
};

const equipMaxPower: AiTool = {
  mutating: true,
  declaration: {
    name: 'equip_max_power',
    description: 'Equip the highest power gear on a character. Can be undone from DIM.',
    parameters: {
      type: 'object',
      properties: {
        characterId: {
          type: 'string',
          description: 'A character id from list_characters. Defaults to the current character.',
        },
      },
    },
  },
  summarize: (args, state) => {
    const store = findCharacter(state, stringArg(args, 'characterId'));
    return { summary: `Equip max power gear on ${store.className}` };
  },
  execute: async (args, getState, dispatch) => {
    const state = getState();
    const store = findCharacter(state, stringArg(args, 'characterId'));
    const loadout = maxLightLoadout(allItemsSelector(state), store);
    await dispatch(applyLoadout(store, loadout, { allowUndo: true }));
    return { result: `Equipped max power gear on ${store.className}` };
  },
};

export const aiTools: AiTool[] = [
  listCharacters,
  searchItemsTool,
  describeItem,
  listLoadouts,
  moveItem,
  equipItems,
  applyLoadoutTool,
  createLoadout,
  equipMaxPower,
];

export const aiToolsByName = Object.fromEntries(aiTools.map((t) => [t.declaration.name, t]));

/** Turn thrown errors into { error } results so the model can recover. */
function toErrorResult(e: unknown): { error: string } {
  return { error: e instanceof Error ? e.message : String(e) };
}

/** Run a tool, never throwing. Unknown tools and bad arguments return { error }. */
export async function runTool(
  name: string,
  args: ToolArgs,
  getState: () => RootState,
  dispatch: DimThunkDispatch,
): Promise<ToolResult> {
  const tool = aiToolsByName[name];
  if (!tool) {
    return { error: `Unknown tool "${name}"` };
  }
  try {
    return await tool.execute(args ?? {}, getState, dispatch);
  } catch (e) {
    return toErrorResult(e);
  }
}

/** Summarize a mutating tool call for the confirm card, never throwing. */
export function summarizeTool(
  name: string,
  args: ToolArgs,
  state: RootState,
): { summary: string } | { error: string } {
  const tool = aiToolsByName[name];
  if (!tool?.summarize) {
    return { error: `Unknown tool "${name}"` };
  }
  try {
    return tool.summarize(args ?? {}, state);
  } catch (e) {
    return toErrorResult(e);
  }
}
