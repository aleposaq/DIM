import { D2ManifestDefinitions } from 'app/destiny2/d2-definitions';
import { DimItem, DimSocket } from 'app/inventory/item-types';
import { unlockedPlugSetItemsSelector } from 'app/inventory/selectors';
import { DimStore } from 'app/inventory/store-types';
import {
  convertToLoadoutItem,
  getLoadoutSubclassFragmentCapacity,
} from 'app/loadout-drawer/loadout-utils';
import { LoadoutItem, ResolvedLoadoutItem } from 'app/loadout/loadout-types';
import { isInsertableArmor2Mod } from 'app/loadout/mod-utils';
import { d2ManifestSelector } from 'app/manifest/selectors';
import { RootState } from 'app/store/types';
import {
  aspectSocketCategoryHashes,
  fragmentSocketCategoryHashes,
  getSocketsByCategoryHashes,
  subclassAbilitySocketCategoryHashes,
} from 'app/utils/socket-utils';
import memoizeOne from 'memoize-one';
import { subclassesFor } from './game-knowledge';

/** A thrown error whose message is shown to the model. */
export class ConfigError extends Error {}

export interface SubclassRequest {
  /** Part of the subclass name, e.g. "Striker" */
  name: string;
  /** Super and abilities (grenade, melee, class ability, jump), by name */
  abilities: string[];
  aspects: string[];
  fragments: string[];
}

const norm = (s: string) => s.trim().toLowerCase();

/** Find an unlocked plug in a socket by name: exact match first, then substring. */
function findPlug(socket: DimSocket, name: string, unlocked: Set<number>) {
  const plugs = (socket.plugSet?.plugs ?? []).filter((p) => unlocked.has(p.plugDef.hash));
  const wanted = norm(name);
  return (
    plugs.find((p) => norm(p.plugDef.displayProperties.name) === wanted) ??
    plugs.find((p) => norm(p.plugDef.displayProperties.name).includes(wanted))
  );
}

/**
 * Turn subclass choices into a loadout item with socket overrides, checking
 * that every choice exists, is unlocked, and fits.
 */
export function subclassLoadoutItem(
  state: RootState,
  store: DimStore,
  request: SubclassRequest,
): { item: DimItem; loadoutItem: LoadoutItem; chosen: string[] } {
  const defs = d2ManifestSelector(state);
  const wanted = norm(request.name);
  const subclass = subclassesFor(store).find((s) => norm(s.name).includes(wanted));
  if (!subclass?.sockets || !defs) {
    throw new ConfigError(
      `${store.className} has no subclass matching "${request.name}". They have: ${subclassesFor(
        store,
      )
        .map((s) => s.name)
        .join(', ')}`,
    );
  }
  const unlocked = unlockedPlugSetItemsSelector(store.id)(state);
  const overrides: Record<number, number> = {};
  const chosen: string[] = [];

  // Abilities: each one goes in the first free socket that offers it
  const abilitySockets = getSocketsByCategoryHashes(
    subclass.sockets,
    subclassAbilitySocketCategoryHashes,
  );
  for (const name of request.abilities) {
    const match = abilitySockets
      .filter((s) => overrides[s.socketIndex] === undefined)
      .map((s) => ({ socket: s, plug: findPlug(s, name, unlocked) }))
      .find((m) => m.plug);
    if (!match?.plug) {
      throw new ConfigError(
        `"${name}" isn't an unlocked super or ability on ${subclass.name}, or its slot is already taken`,
      );
    }
    overrides[match.socket.socketIndex] = match.plug.plugDef.hash;
    chosen.push(match.plug.plugDef.displayProperties.name);
  }

  // Aspects and fragments fill their sockets in order
  const fill = (sockets: DimSocket[], names: string[], kind: string) => {
    if (names.length > sockets.length) {
      throw new ConfigError(`${subclass.name} only has ${sockets.length} ${kind} slots`);
    }
    for (const [i, name] of names.entries()) {
      const plug = findPlug(sockets[i], name, unlocked);
      if (!plug) {
        throw new ConfigError(`"${name}" isn't an unlocked ${kind} for ${subclass.name}`);
      }
      overrides[sockets[i].socketIndex] = plug.plugDef.hash;
      chosen.push(plug.plugDef.displayProperties.name);
    }
  };
  fill(
    getSocketsByCategoryHashes(subclass.sockets, aspectSocketCategoryHashes),
    request.aspects,
    'aspect',
  );
  const loadoutItem: LoadoutItem = {
    ...convertToLoadoutItem(subclass, true),
    socketOverrides: overrides,
  };
  if (request.fragments.length) {
    const resolved: ResolvedLoadoutItem = { item: subclass, loadoutItem };
    const capacity = getLoadoutSubclassFragmentCapacity(defs, resolved, true);
    if (request.fragments.length > capacity) {
      throw new ConfigError(
        `Those aspects give ${capacity} fragment slots, but ${request.fragments.length} fragments were listed`,
      );
    }
  }
  fill(
    getSocketsByCategoryHashes(subclass.sockets, fragmentSocketCategoryHashes),
    request.fragments,
    'fragment',
  );
  return { item: subclass, loadoutItem, chosen };
}

/** All insertable armor mods, by lowercase name. */
const armorModsByName = memoizeOne((defs: D2ManifestDefinitions) => {
  const byName = new Map<string, number[]>();
  for (const def of Object.values(defs.InventoryItem.getAll())) {
    if (isInsertableArmor2Mod(def) && def.displayProperties.name) {
      const key = norm(def.displayProperties.name);
      byName.set(key, [...(byName.get(key) ?? []), def.hash]);
    }
  }
  return byName;
});

/**
 * Resolve armor mod names to hashes for loadout.parameters.mods, preferring
 * versions the character has unlocked. DIM assigns them to armor pieces when
 * the loadout is applied. Repeat a name to use a mod more than once.
 */
export function armorModHashes(state: RootState, store: DimStore, names: string[]) {
  const defs = d2ManifestSelector(state);
  if (!defs) {
    throw new ConfigError('Game data is still loading. Try again in a moment.');
  }
  const unlocked = unlockedPlugSetItemsSelector(store.id)(state);
  const byName = armorModsByName(defs);
  return names.map((name) => {
    const hashes = byName.get(norm(name));
    if (!hashes) {
      throw new ConfigError(
        `No armor mod named "${name}". Check the exact name with lookup_game_data.`,
      );
    }
    return hashes.find((h) => unlocked.has(h)) ?? hashes[0];
  });
}
