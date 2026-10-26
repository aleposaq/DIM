import { DimItem } from 'app/inventory/item-types';
import { DimStore } from 'app/inventory/store-types';
import { RootState } from 'app/store/types';
import { DestinyItemType, TierType } from 'bungie-api-ts/destiny2';
import { BucketHashes, SocketCategoryHashes } from 'data/d2/generated-enums';
import {
  clarityLinesToText,
  describeSubclass,
  isBuildRelevant,
  lookupGameData,
  matchRank,
} from './game-knowledge';

type Def = Parameters<typeof isBuildRelevant>[0];

function def(hash: number, name: string, extra: object = {}): Def {
  return {
    hash,
    displayProperties: { name, description: `${name} description` },
    itemType: DestinyItemType.Mod,
    plug: { plugCategoryIdentifier: 'hunter.arc.aspects' },
    ...extra,
  } as unknown as Def;
}

const cuirass = def(1, 'Cuirass of the Falling Star', {
  itemType: DestinyItemType.Armor,
  itemTypeDisplayName: 'Chest Armor',
  inventory: { tierType: TierType.Exotic },
  plug: undefined,
  sockets: { socketEntries: [{ singleInitialItemHash: 2 }] },
});
const cuirassPerk = def(2, 'Thundercrash Overcharge', {
  plug: { plugCategoryIdentifier: 'intrinsics' },
});
const shader = def(3, 'Falling Star Shader', { plug: { plugCategoryIdentifier: 'shader' } });
const duplicate = def(4, 'Cuirass of the Falling Star', cuirass);
const spark = def(5, 'Spark of Shock', {
  plug: { plugCategoryIdentifier: 'shared.arc.fragments' },
});

const definitions = Object.fromEntries(
  [cuirass, cuirassPerk, shader, duplicate, spark].map((d) => [d.hash, d]),
);

const state = {
  manifest: {
    d2Manifest: {
      InventoryItem: {
        getAll: () => definitions,
        getOptional: (hash: number) => definitions[hash],
      },
      PlugSet: { get: () => undefined },
    },
  },
  clarity: {
    descriptions: {
      2: {
        hash: 2,
        name: 'Thundercrash Overcharge',
        descriptions: {
          en: [
            { linesContent: [{ text: 'Thundercrash damage +150%' }] },
            { linesContent: [{ text: 'Only in PvE', classNames: ['pve'] }] },
          ],
        },
      },
    },
  },
  inventory: {
    profileResponse: {
      profilePlugSets: {
        data: { plugs: { 77: [{ plugItemHash: 5, enabled: true, canInsert: true }] } },
      },
      characterPlugSets: { data: {} },
    },
  },
} as unknown as RootState;

describe('clarityLinesToText', () => {
  it('flattens lines and marks PvE/PvP lines', () => {
    expect(
      clarityLinesToText([
        { linesContent: [{ text: 'Grants ' }, { text: '20%' }, { text: ' 🡅' }] },
        { linesContent: [] },
        { classNames: ['pvp'], linesContent: [{ text: 'Halved in PvP' }] },
      ]),
    ).toBe('Grants 20%\nPvP: Halved in PvP');
    expect(clarityLinesToText(undefined)).toBeUndefined();
  });
});

describe('isBuildRelevant', () => {
  it('keeps exotics and gameplay plugs, drops cosmetics', () => {
    expect(isBuildRelevant(cuirass)).toBe(true);
    expect(isBuildRelevant(spark)).toBe(true);
    expect(isBuildRelevant(shader)).toBe(false);
    expect(
      isBuildRelevant(def(9, 'Blue armor', { itemType: DestinyItemType.Armor, plug: undefined })),
    ).toBe(false);
  });
});

describe('matchRank', () => {
  it('prefers exact, then prefix, then substring matches', () => {
    expect(matchRank('spark of shock', 'spark of shock')).toBe(0);
    expect(matchRank('spark of shock', 'spark')).toBe(1);
    expect(matchRank('spark of shock', 'shock')).toBe(2);
    expect(matchRank('spark of shock', 'void')).toBe(-1);
  });
});

describe('lookupGameData', () => {
  it('finds exotics with their exotic perk and community numbers', () => {
    const result = lookupGameData(state, 'cuirass');
    expect(result).toEqual({
      results: [
        {
          name: 'Cuirass of the Falling Star',
          type: 'Chest Armor',
          description: 'Cuirass of the Falling Star description',
          community: undefined,
          exoticPerks: [
            {
              name: 'Thundercrash Overcharge',
              description: 'Thundercrash Overcharge description',
              community: 'Thundercrash damage +150%\nPvE: Only in PvE',
            },
          ],
        },
      ],
      total: 1,
    });
  });

  it('hints when nothing matches and rejects tiny queries', () => {
    const result = lookupGameData(state, 'gjallarhorn');
    expect(result).toHaveProperty('results', []);
    expect(result).toHaveProperty('hint');
    expect(lookupGameData(state, 'a')).toHaveProperty('error');
  });

  it('waits for game data to load', () => {
    const loading = { ...state, manifest: {} } as unknown as RootState;
    expect(lookupGameData(loading, 'spark')).toHaveProperty('error');
  });
});

describe('describeSubclass', () => {
  it('shows equipped fragments and the unlocked options', () => {
    const plug = (hash: number, name: string) => ({
      plugDef: { hash, displayProperties: { name, description: `${name} does things` } },
    });
    const subclass = {
      name: 'Arcstrider',
      equipped: true,
      bucket: { hash: BucketHashes.Subclass },
      sockets: {
        allSockets: [
          {
            socketIndex: 0,
            plugged: plug(5, 'Spark of Shock'),
            plugSet: { plugs: [plug(5, 'Spark of Shock'), plug(6, 'Spark of Ions')] },
          },
        ],
        categories: [
          { category: { hash: SocketCategoryHashes.Fragments_Abilities }, socketIndexes: [0] },
        ],
      },
    } as unknown as DimItem;
    const store = {
      id: 'char1',
      stats: { 1: { displayProperties: { name: 'Melee' }, value: 120 } },
      items: [subclass],
    } as unknown as DimStore;

    const result = describeSubclass(state, store, subclass);
    expect(result).toMatchObject({
      subclass: 'Arcstrider',
      fragments: [{ name: 'Spark of Shock', description: 'Spark of Shock does things' }],
      fragmentSlots: 1,
      // Spark of Ions isn't unlocked
      availableFragments: [{ name: 'Spark of Shock', description: 'Spark of Shock does things' }],
      characterStats: { Melee: 120 },
    });
  });
});
