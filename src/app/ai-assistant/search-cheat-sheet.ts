import { buildItemFiltersMap } from 'app/search/items/item-search-filter';

/**
 * Hand-picked examples of common filters. Every one of these is checked against
 * DIM's real filter definitions (see search-cheat-sheet.test.ts), and any that
 * stop existing are dropped from the prompt.
 */
export const commonFilterExamples = [
  'is:weapon',
  'is:armor',
  'is:exotic',
  'is:legendary',
  'is:void',
  'is:solar',
  'is:arc',
  'is:stasis',
  'is:strand',
  'is:kinetic',
  'is:handcannon',
  'is:autorifle',
  'is:rocketlauncher',
  'is:sword',
  'is:titan',
  'is:hunter',
  'is:warlock',
  'is:helmet',
  'is:chest',
  'is:equipped',
  'is:inloadout',
  'is:incurrentchar',
  'is:invault',
  'is:locked',
  'is:crafted',
  'is:masterwork',
  'name:',
  'perk:',
  'perkname:',
  'power:',
  'tier:',
  'stat:',
];

/** The left-hand side of a filter example, e.g. "is:void" -> ["is", "void"], "power:" -> ["power"] */
function splitExample(example: string) {
  const [lhs, rhs] = example.split(':');
  return { lhs, rhs };
}

/** Is this example a real filter in DIM's D2 filter definitions? */
export function isKnownFilterExample(example: string) {
  const { isFilters, kvFilters } = buildItemFiltersMap(2);
  const { lhs, rhs } = splitExample(example);
  return lhs === 'is' ? Boolean(rhs && isFilters[rhs]) : Boolean(kvFilters[lhs]);
}

/** All non-deprecated `is:` keywords and `keyword:` filter names DIM knows about for D2. */
export function allFilterKeywords() {
  const { isFilters, kvFilters } = buildItemFiltersMap(2);
  const isKeywords = Object.entries(isFilters)
    .filter(([, f]) => !f.deprecated)
    .map(([k]) => k)
    .sort();
  const kvKeywords = Object.entries(kvFilters)
    .filter(([, f]) => !f.deprecated)
    .map(([k]) => k)
    .sort();
  return { isKeywords, kvKeywords };
}

/** A compact search syntax reference for the system instruction. */
export function searchCheatSheet() {
  const examples = commonFilterExamples.filter(isKnownFilterExample);
  const { isKeywords, kvKeywords } = allFilterKeywords();
  return [
    'DIM search syntax:',
    '- Combine filters with spaces (AND), "or", "-" or "not:" to negate, and parentheses.',
    '- Quote multi-word values: name:"gjallarhorn", perk:"kill clip".',
    '- Numeric filters take comparisons: power:>=2000, stat:recovery:>=100.',
    `Common filters: ${examples.join(' ')}`,
    `All is: keywords: ${isKeywords.join(' ')}`,
    `All keyword:value filters: ${kvKeywords.join(' ')}`,
  ].join('\n');
}
