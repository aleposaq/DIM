import { DimItem } from 'app/inventory/item-types';
import { DimStore } from 'app/inventory/store-types';
import { knownModPlugCategoryHashes } from 'app/loadout/known-values';
import { RootState } from 'app/store/types';
import { BucketHashes, SocketCategoryHashes } from 'data/d2/generated-enums';
import { armorModHashes, ConfigError, subclassLoadoutItem } from './loadout-config';

function plugDef(hash: number, name: string, extra: object = {}) {
  return { hash, displayProperties: { name, description: '' }, ...extra };
}

const thundercrash = plugDef(10, 'Thundercrash');
const fistsOfHavoc = plugDef(11, 'Fists of Havoc');
const thunderclap = plugDef(12, 'Thunderclap');
// Each aspect gives 2 fragment slots
const knockout = plugDef(20, 'Knockout', { plug: { energyCapacity: { capacityValue: 2 } } });
const juggernaut = plugDef(21, 'Juggernaut', { plug: { energyCapacity: { capacityValue: 2 } } });
const lockedAspect = plugDef(22, 'Locked Aspect', {
  plug: { energyCapacity: { capacityValue: 2 } },
});
const sparkOfShock = plugDef(30, 'Spark of Shock');
const sparkOfIons = plugDef(31, 'Spark of Ions');
const sparkOfFocus = plugDef(32, 'Spark of Focus');
const fragments = [sparkOfShock, sparkOfIons, sparkOfFocus];

const socket = (socketIndex: number, plugs: object[]) => ({
  socketIndex,
  plugged: null,
  plugSet: { plugs: plugs.map((p) => ({ plugDef: p })) },
});

const striker = {
  id: 'striker1',
  hash: 999,
  name: 'Striker',
  amount: 1,
  equipped: true,
  bucket: { hash: BucketHashes.Subclass },
  sockets: {
    allSockets: [
      socket(0, [thundercrash, fistsOfHavoc]),
      socket(1, [thunderclap]),
      socket(2, [knockout, juggernaut, lockedAspect]),
      socket(3, [knockout, juggernaut, lockedAspect]),
      socket(4, fragments),
      socket(5, fragments),
      socket(6, fragments),
      socket(7, fragments),
    ],
    categories: [
      { category: { hash: SocketCategoryHashes.Super }, socketIndexes: [0] },
      { category: { hash: SocketCategoryHashes.Abilities_Abilities }, socketIndexes: [1] },
      { category: { hash: SocketCategoryHashes.Aspects_Abilities }, socketIndexes: [2, 3] },
      { category: { hash: SocketCategoryHashes.Fragments_Abilities }, socketIndexes: [4, 5, 6, 7] },
    ],
  },
} as unknown as DimItem;

const titan = {
  id: 'char1',
  className: 'Titan',
  items: [striker],
} as unknown as DimStore;

const modCategory = knownModPlugCategoryHashes[0];
const definitions: Record<number, object> = Object.fromEntries(
  [
    thundercrash,
    knockout,
    juggernaut,
    lockedAspect,
    plugDef(40, 'Grenade Kickstart', {
      itemTypeDisplayName: 'Mod',
      plug: { plugCategoryHash: modCategory },
    }),
    plugDef(41, 'Grenade Kickstart', {
      itemTypeDisplayName: 'Mod',
      plug: { plugCategoryHash: modCategory },
    }),
  ].map((d) => [d.hash, d]),
);

const unlockedHashes = [10, 11, 12, 20, 21, 30, 31, 32, 41];
const state = {
  manifest: {
    d2Manifest: {
      InventoryItem: {
        get: (hash: number) => definitions[hash],
        getAll: () => definitions,
      },
      PlugSet: { get: () => undefined },
    },
  },
  inventory: {
    profileResponse: {
      profilePlugSets: {
        data: {
          plugs: {
            1: unlockedHashes.map((plugItemHash) => ({
              plugItemHash,
              enabled: true,
              canInsert: true,
            })),
          },
        },
      },
      characterPlugSets: { data: {} },
    },
  },
} as unknown as RootState;

describe('subclassLoadoutItem', () => {
  it('turns names into socket overrides', () => {
    const { loadoutItem, chosen } = subclassLoadoutItem(state, titan, {
      name: 'striker',
      abilities: ['Thundercrash', 'Thunderclap'],
      aspects: ['Knockout', 'Juggernaut'],
      fragments: ['Spark of Shock', 'Spark of Ions', 'Spark of Focus'],
    });
    expect(loadoutItem).toMatchObject({
      id: 'striker1',
      hash: 999,
      equip: true,
      socketOverrides: { 0: 10, 1: 12, 2: 20, 3: 21, 4: 30, 5: 31, 6: 32 },
    });
    expect(chosen).toEqual([
      'Thundercrash',
      'Thunderclap',
      'Knockout',
      'Juggernaut',
      'Spark of Shock',
      'Spark of Ions',
      'Spark of Focus',
    ]);
  });

  it('rejects locked options, unknown subclasses, and too many fragments', () => {
    const base = { name: 'Striker', abilities: [], aspects: [], fragments: [] };
    expect(() =>
      subclassLoadoutItem(state, titan, { ...base, aspects: ['Locked Aspect'] }),
    ).toThrow(ConfigError);
    expect(() => subclassLoadoutItem(state, titan, { ...base, name: 'Sunbreaker' })).toThrow(
      /has no subclass matching/,
    );
    // One aspect gives 2 slots
    expect(() =>
      subclassLoadoutItem(state, titan, {
        ...base,
        aspects: ['Knockout'],
        fragments: ['Spark of Shock', 'Spark of Ions', 'Spark of Focus'],
      }),
    ).toThrow(/2 fragment slots/);
    // Both super options share one socket
    expect(() =>
      subclassLoadoutItem(state, titan, { ...base, abilities: ['Thundercrash', 'Fists of Havoc'] }),
    ).toThrow(/already taken/);
  });
});

describe('armorModHashes', () => {
  it('prefers the unlocked copy and keeps repeats', () => {
    expect(armorModHashes(state, titan, ['grenade kickstart', 'Grenade Kickstart'])).toEqual([
      41, 41,
    ]);
    expect(() => armorModHashes(state, titan, ['Not A Mod'])).toThrow(/No armor mod named/);
  });
});
