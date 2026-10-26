import { ClarityDescription, Line } from 'app/clarity/descriptions/descriptionInterface';
import { clarityDescriptionsSelector } from 'app/clarity/selectors';
import { D2ManifestDefinitions } from 'app/destiny2/d2-definitions';
import { DimItem, DimSocket } from 'app/inventory/item-types';
import { availableArtifactsSelector, unlockedPlugSetItemsSelector } from 'app/inventory/selectors';
import { DimStore } from 'app/inventory/store-types';
import { d2ManifestSelector } from 'app/manifest/selectors';
import { RootState } from 'app/store/types';
import {
  aspectSocketCategoryHashes,
  fragmentSocketCategoryHashes,
  getSocketsByCategoryHashes,
  subclassAbilitySocketCategoryHashes,
} from 'app/utils/socket-utils';
import { DestinyInventoryItemDefinition, DestinyItemType, TierType } from 'bungie-api-ts/destiny2';
import { BucketHashes } from 'data/d2/generated-enums';
import memoizeOne from 'memoize-one';

/** Max results from one lookup_game_data call. */
export const MAX_LOOKUP_RESULTS = 8;

/**
 * Plug categories that are cosmetic or otherwise useless for build crafting.
 * Matched as substrings of plugCategoryIdentifier.
 */
const ignoredPlugCategories = [
  'shader',
  'skins',
  'ornament',
  'emote',
  'transmat',
  'finisher',
  'ghost',
  'ship',
  'sparrow',
  'masterworks.trackers',
  'crafting',
  'memento',
  'v300.weapon.damage_type',
  'enhancements.season',
];

/** Turn Clarity's formatted lines into plain text, marking PvE/PvP-only lines. */
export function clarityLinesToText(lines: Line[] | undefined) {
  if (!lines) {
    return undefined;
  }
  const text = lines
    .map((line) => {
      const content = (line.linesContent ?? [])
        .map((c) => c.text ?? '')
        .join('')
        .replace('🡅', '')
        .trim();
      if (!content) {
        return '';
      }
      const classNames = [
        ...(line.classNames ?? []),
        ...(line.linesContent ?? []).flatMap((c) => c.classNames ?? []),
      ];
      const prefix = classNames.includes('pve')
        ? 'PvE: '
        : classNames.includes('pvp')
          ? 'PvP: '
          : '';
      return prefix + content;
    })
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function clarityText(descriptions: ClarityDescription | undefined, hash: number) {
  return clarityLinesToText(descriptions?.[hash]?.descriptions.en);
}

/** Is this definition something a build crafter would look up? */
export function isBuildRelevant(def: DestinyInventoryItemDefinition) {
  const name = def.displayProperties?.name;
  if (!name || def.redacted) {
    return false;
  }
  if (def.itemType === DestinyItemType.Armor || def.itemType === DestinyItemType.Weapon) {
    // Exotics, plus legendary weapons (their perks matter for builds)
    return (
      def.inventory?.tierType === TierType.Exotic ||
      (def.itemType === DestinyItemType.Weapon &&
        def.inventory?.tierType === TierType.Superior &&
        Boolean(def.collectibleHash))
    );
  }
  const category = def.plug?.plugCategoryIdentifier;
  if (!category || !def.displayProperties.description) {
    return false;
  }
  return !ignoredPlugCategories.some((ignored) => category.includes(ignored));
}

interface IndexEntry {
  def: DestinyInventoryItemDefinition;
  lowerName: string;
}

/** All build-relevant definitions, deduplicated by name and description. */
const buildIndex = memoizeOne((defs: D2ManifestDefinitions) => {
  const seen = new Set<string>();
  const entries: IndexEntry[] = [];
  for (const def of Object.values(defs.InventoryItem.getAll())) {
    if (!isBuildRelevant(def)) {
      continue;
    }
    const key = `${def.displayProperties.name}|${def.itemType}|${def.displayProperties.description}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push({ def, lowerName: def.displayProperties.name.toLowerCase() });
  }
  return entries;
});

/** Rank: exact name, then prefix, then substring. Lower is better. */
export function matchRank(lowerName: string, query: string) {
  if (lowerName === query) {
    return 0;
  }
  if (lowerName.startsWith(query)) {
    return 1;
  }
  if (lowerName.includes(query)) {
    return 2;
  }
  return -1;
}

function exoticPerks(
  defs: D2ManifestDefinitions,
  descriptions: ClarityDescription | undefined,
  def: DestinyInventoryItemDefinition,
) {
  const perks: { name: string; description: string; community?: string }[] = [];
  for (const entry of def.sockets?.socketEntries ?? []) {
    const plug = entry.singleInitialItemHash
      ? defs.InventoryItem.getOptional(entry.singleInitialItemHash)
      : undefined;
    if (plug?.plug?.plugCategoryIdentifier === 'intrinsics' && plug.displayProperties.name) {
      perks.push({
        name: plug.displayProperties.name,
        description: plug.displayProperties.description,
        community: clarityText(descriptions, plug.hash),
      });
    }
  }
  return perks;
}

/** Search the game's definitions for exotics, perks, mods, aspects, fragments and abilities. */
export function lookupGameData(state: RootState, query: string) {
  const defs = d2ManifestSelector(state);
  if (!defs) {
    return { error: 'Game data is still loading. Try again in a moment.' };
  }
  const descriptions = clarityDescriptionsSelector(state);
  const lowerQuery = query.trim().toLowerCase();
  if (lowerQuery.length < 2) {
    return { error: 'Search for at least 2 characters of a name' };
  }

  const matches = buildIndex(defs)
    .map((entry) => ({ entry, rank: matchRank(entry.lowerName, lowerQuery) }))
    .filter((m) => m.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.entry.lowerName.length - b.entry.lowerName.length);

  if (!matches.length) {
    return {
      results: [],
      hint: 'Nothing matched. Try a shorter or different part of the name.',
    };
  }

  return {
    results: matches.slice(0, MAX_LOOKUP_RESULTS).map(({ entry: { def } }) => {
      const isGear =
        def.itemType === DestinyItemType.Armor || def.itemType === DestinyItemType.Weapon;
      return {
        name: def.displayProperties.name,
        type: def.itemTypeDisplayName || undefined,
        description: def.displayProperties.description || undefined,
        // Community-tested numbers from Clarity, when available
        community: clarityText(descriptions, def.hash),
        exoticPerks:
          isGear && def.inventory?.tierType === TierType.Exotic
            ? exoticPerks(defs, descriptions, def)
            : undefined,
      };
    }),
    total: matches.length,
  };
}

function plugSummary(socket: DimSocket, descriptions: ClarityDescription | undefined) {
  const plug = socket.plugged?.plugDef;
  if (!plug?.displayProperties.name) {
    return undefined;
  }
  return {
    name: plug.displayProperties.name,
    description: plug.displayProperties.description || undefined,
    community: clarityText(descriptions, plug.hash),
  };
}

/** Names of the unlocked plugs that fit these sockets, without duplicates. */
function availableOptions(sockets: DimSocket[], unlocked: Set<number>) {
  const names = new Set<string>();
  for (const socket of sockets) {
    for (const plug of socket.plugSet?.plugs ?? []) {
      const name = plug.plugDef.displayProperties.name;
      if (name && unlocked.has(plug.plugDef.hash)) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

/** The character's stats, by name. */
export function characterStats(store: DimStore) {
  return Object.fromEntries(
    Object.values(store.stats).map((stat) => [stat.displayProperties.name, stat.value]),
  );
}

/**
 * A subclass's super, abilities, aspects and fragments, plus the unlocked
 * options for each, and the character's stats.
 */
export function describeSubclass(state: RootState, store: DimStore, subclass: DimItem) {
  const descriptions = clarityDescriptionsSelector(state);
  const unlocked = unlockedPlugSetItemsSelector(store.id)(state);
  const sockets = subclass.sockets;
  if (!sockets) {
    return { error: `No details available for ${subclass.name}` };
  }

  const abilitySockets = getSocketsByCategoryHashes(sockets, subclassAbilitySocketCategoryHashes);
  const aspectSockets = getSocketsByCategoryHashes(sockets, aspectSocketCategoryHashes);
  const fragmentSockets = getSocketsByCategoryHashes(sockets, fragmentSocketCategoryHashes);

  return {
    subclass: subclass.name,
    equipped: subclass.equipped,
    abilities: abilitySockets.map((s) => ({
      slot: s.plugged?.plugDef.itemTypeDisplayName || undefined,
      ...plugSummary(s, descriptions),
      options: availableOptions([s], unlocked),
    })),
    aspects: aspectSockets.map((s) => plugSummary(s, descriptions)).filter(Boolean),
    availableAspects: availableOptions(aspectSockets, unlocked),
    fragments: fragmentSockets.map((s) => plugSummary(s, descriptions)).filter(Boolean),
    fragmentSlots: fragmentSockets.length,
    availableFragments: availableOptions(fragmentSockets, unlocked),
    characterStats: characterStats(store),
  };
}

/** All subclasses a character has, equipped first. */
export function subclassesFor(store: DimStore) {
  return store.items
    .filter((i) => i.bucket.hash === BucketHashes.Subclass)
    .sort((a, b) => Number(b.equipped) - Number(a.equipped));
}

/** The character's seasonal artifact perks that are currently active. */
export function describeArtifact(state: RootState, store: DimStore) {
  const descriptions = clarityDescriptionsSelector(state);
  const [artifact] = availableArtifactsSelector(store.id)(state);
  if (!artifact?.sockets) {
    return { error: 'No seasonal artifact found' };
  }
  const perks = artifact.sockets.allSockets
    .filter((s) => s.isPerk || s.isReusable)
    .map((s) => plugSummary(s, descriptions))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    // Empty perk slots have generic names and no description
    .filter((p) => p.description);
  return { artifact: artifact.name, activePerks: perks };
}
