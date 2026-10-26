import {
  allFilterKeywords,
  commonFilterExamples,
  isKnownFilterExample,
  searchCheatSheet,
} from './search-cheat-sheet';

describe('search cheat sheet', () => {
  it.each(commonFilterExamples)('%s is a real DIM filter', (example) => {
    expect(isKnownFilterExample(example)).toBe(true);
  });

  it('rejects made-up filters', () => {
    expect(isKnownFilterExample('is:notarealfilter')).toBe(false);
    expect(isKnownFilterExample('notarealfilter:')).toBe(false);
  });

  it('lists keywords from the filter definitions', () => {
    const { isKeywords, kvKeywords } = allFilterKeywords();
    expect(isKeywords).toContain('weapon');
    expect(kvKeywords).toContain('perk');
  });

  it('stays small enough for the prompt', () => {
    expect(searchCheatSheet().length).toBeLessThan(12_000);
  });
});
