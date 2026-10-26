import { DimItem } from 'app/inventory/item-types';
import { aiTools, perkNames, summarizeItem, ToolSchema } from './tools';

function checkSchema(schema: ToolSchema, path: string) {
  expect(['object', 'string', 'number', 'integer', 'boolean', 'array']).toContain(schema.type);
  if (schema.type === 'object') {
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      checkSchema(prop, `${path}.${key}`);
    }
    for (const required of schema.required ?? []) {
      expect(Object.keys(schema.properties ?? {})).toContain(required);
    }
  }
  if (schema.type === 'array') {
    expect(schema.items).toBeDefined();
    checkSchema(schema.items!, `${path}[]`);
  }
}

describe('aiTools declarations', () => {
  it('have unique names', () => {
    const names = aiTools.map((t) => t.declaration.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(aiTools.map((t) => [t.declaration.name, t] as const))(
    '%s has a name, description and valid parameters',
    (_name, tool) => {
      const { declaration } = tool;
      expect(declaration.name).toMatch(/^[a-z_]+$/);
      expect(declaration.description.length).toBeGreaterThan(10);
      expect(declaration.parameters.type).toBe('object');
      checkSchema(declaration.parameters, declaration.name);
    },
  );

  it('mutating tools can summarize themselves for the confirm card', () => {
    for (const tool of aiTools) {
      expect(Boolean(tool.summarize)).toBe(tool.mutating);
    }
  });
});

function fakeItem(): DimItem {
  const plug = (name: string) => ({ plugDef: { displayProperties: { name } } });
  return {
    index: '6917529-42',
    name: 'Gjallarhorn',
    typeName: 'Rocket Launcher',
    rarity: 'Exotic',
    power: 2010,
    element: { displayProperties: { name: 'Solar' } },
    bucket: { name: 'Power Weapons' },
    equipped: true,
    locked: false,
    sockets: {
      allSockets: [
        { isPerk: false, plugged: plug('Shader') },
        { isPerk: true, plugged: plug('Wolfpack Rounds') },
        { isPerk: true, plugged: plug('Tracking Module') },
        { isPerk: true, plugged: plug('Tracking Module') },
        { isPerk: true, plugged: null },
        { isPerk: true, plugged: plug('') },
        { isPerk: true, plugged: plug('Impact Casing') },
        { isPerk: true, plugged: plug('Lightweight Frame') },
        { isPerk: true, plugged: plug('Smooth Grip') },
      ],
      categories: [],
      fromDefinitions: false,
    },
  } as unknown as DimItem;
}

describe('summarizeItem', () => {
  it('builds a compact summary', () => {
    expect(summarizeItem(fakeItem(), 'Hunter')).toEqual({
      index: '6917529-42',
      name: 'Gjallarhorn',
      type: 'Rocket Launcher',
      tier: 'Exotic',
      power: 2010,
      element: 'Solar',
      slot: 'Power Weapons',
      owner: 'Hunter',
      equipped: true,
      locked: false,
      perks: ['Wolfpack Rounds', 'Tracking Module', 'Impact Casing', 'Lightweight Frame'],
    });
  });

  it('handles items without sockets or element', () => {
    const item = { ...fakeItem(), sockets: null, element: null } as DimItem;
    const summary = summarizeItem(item, 'vault');
    expect(summary.perks).toEqual([]);
    expect(summary.element).toBeUndefined();
    expect(summary.owner).toBe('vault');
  });

  it('dedupes perk names and skips empty ones', () => {
    expect(perkNames(fakeItem())).toEqual([
      'Wolfpack Rounds',
      'Tracking Module',
      'Impact Casing',
      'Lightweight Frame',
      'Smooth Grip',
    ]);
  });
});
