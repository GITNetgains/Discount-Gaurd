import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { scopeReplacement, protectedProductIds } from '../app/lib/discount-scope.ts';

const db = {
  mappings: [], rule: 'any',
  discountSettings: { findUnique: async () => ({ compareAtRule: db.rule }) },
  discountCollectionMirror: {
    findMany: async () => db.mappings,
    upsert: async ({ create }) => {
      db.mappings = db.mappings.filter(m => m.originalCollectionId !== create.originalCollectionId);
      db.mappings.push(create);
    },
  },
};
globalThis.__discountProtectionTestDb = db;
const code = ts.transpileModule(await readFile(new URL('../app/models/discount-protection.server.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
  .replace('import prisma from "../db.server";', 'const prisma = globalThis.__discountProtectionTestDb;')
  .replace('"../lib/discount-scope"', JSON.stringify(new URL('../app/lib/discount-scope.ts', import.meta.url).href))
  .replace('import { ELIGIBLE_COLLECTION_HANDLE } from "./eligibility.server";', 'const ELIGIBLE_COLLECTION_HANDLE = "discount-guard-eligible";');
const { syncDiscountProtection } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

function mock() {
  db.mappings = []; db.rule = 'any';
  const collections = new Map([
    ['original-a', { id: 'original-a', title: 'A', handle: 'a', sources: [], ids: ['normal', 'compare', 'map-normal'] }],
    ['original-b', { id: 'original-b', title: 'B', handle: 'b', sources: [], ids: ['other-normal'] }],
  ]);
  const nodes = ['a', 'b'].map((name, index) => ({ id: `discount-${name}`, discount: { __typename: 'DiscountCodeBasic', title: name, customerGets: { items: { __typename: 'DiscountCollections', collections: { nodes: [{ id: `original-${name}`, handle: name }], pageInfo: { hasNextPage: false } } } } } }));
  nodes.push({ id: 'bundle', discount: { __typename: 'DiscountAutomaticApp' } });
  const mutations = [];
  const admin = { graphql: async (query, { variables: vars }) => {
    let data;
    if (query.includes('query ProtectableDiscounts')) data = { discountNodes: { nodes, pageInfo: { hasNextPage: false } } };
    else if (query.includes('query ComparePricedProducts')) data = { productVariants: { nodes: [{ compareAtPrice: '100.00', product: { id: 'compare' } }], pageInfo: { hasNextPage: false } } };
    else if (query.includes('query ProtectionCollection')) {
      const state = collections.get(vars.id);
      data = { collection: state ? { ...state, products: { nodes: state.ids.map(id => ({ id })), pageInfo: { hasNextPage: false } } } : null };
    } else if (query.includes('query FindProtectionCollection')) data = { collectionByIdentifier: [...collections.values()].find(c => c.handle === vars.handle) ?? null };
    else if (query.includes('mutation CreateProtectionCollection')) {
      const id = `mirror-${collections.size}`;
      collections.set(id, { id, title: vars.input.title, handle: vars.input.handle, sources: [], ids: [] });
      data = { collectionCreate: { collection: { id }, userErrors: [] } };
    } else if (query.includes('mutation UpdateProtectionCollection')) {
      const state = collections.get(vars.input.id);
      mutations.push({ kind: 'collection', input: vars.input });
      if (vars.input.sourcesToCreate) {
        const source = vars.input.sourcesToCreate[0].source;
        state.sources = [{ id: `source-${state.id}`, title: source.title, __typename: 'CollectionConditionsSource' }];
        state.ids = source.inclusion.selections.map(p => p.productId);
      }
      if (vars.input.sourcesToDelete) { state.sources = []; state.ids = []; }
      if (vars.input.sourcesToUpdate) {
        const changes = vars.input.sourcesToUpdate[0].condition.inclusion;
        state.ids = [...new Set([...state.ids, ...changes.selectionsToAdd.map(p => p.productId)])].filter(id => !changes.selectionsToRemove.some(p => p.productId === id));
      }
      data = { collectionUpdate: { collection: state, userErrors: [] } };
    } else if (query.includes('mutation ProtectCodeScope')) {
      mutations.push({ kind: 'discount', ...vars });
      const target = nodes.find(node => node.id === vars.id).discount.customerGets.items.collections;
      const delta = vars.input.customerGets.items.collections;
      target.nodes = target.nodes.filter(n => !delta.remove.includes(n.id));
      target.nodes.push(...delta.add.map(id => ({ id, handle: collections.get(id).handle })));
      data = { discountCodeBasicUpdate: { userErrors: [], codeDiscountNode: { id: vars.id } } };
    } else throw new Error('Unexpected operation');
    return { json: async () => ({ data }) };
  } };
  return { admin, nodes, collections, mutations };
}

test('scope replacement preserves unrelated targets and never broadens the original product selection', () => {
  assert.deepEqual(scopeReplacement(['a', 'b'], new Map([['a', 'mirror-a']])), { add: ['mirror-a'], remove: ['a'] });
  assert.deepEqual(protectedProductIds(['normal', 'compare', 'map-normal'], new Set(['compare'])), ['normal', 'map-normal']);
});

test('ON protects existing codes, preserves original collections and does not change discount values', async () => {
  const fixture = mock();
  const result = await syncDiscountProtection(fixture.admin, 'shop', 'any');
  assert.deepEqual(result, { updated: 2, managed: 2, unsupported: 1 });
  assert.deepEqual(fixture.collections.get('original-a').ids, ['normal', 'compare', 'map-normal']);
  const mirror = fixture.collections.get(fixture.nodes[0].discount.customerGets.items.collections.nodes[0].id);
  assert.deepEqual(mirror.ids, ['normal', 'map-normal']);
  assert.ok(!fixture.collections.get(fixture.nodes[1].discount.customerGets.items.collections.nodes[0].id).ids.includes('normal'));
  for (const mutation of fixture.mutations.filter(m => m.kind === 'discount')) assert.deepEqual(Object.keys(mutation.input), ['customerGets']);
});

test('OFF restores each code to its own original scope and ON can be safely repeated', async () => {
  const fixture = mock();
  await syncDiscountProtection(fixture.admin, 'shop', 'any');
  const again = await syncDiscountProtection(fixture.admin, 'shop', 'any');
  assert.equal(again.updated, 0);
  db.rule = 'off';
  const restored = await syncDiscountProtection(fixture.admin, 'shop', 'off');
  assert.equal(restored.updated, 2);
  assert.equal(fixture.nodes[0].discount.customerGets.items.collections.nodes[0].id, 'original-a');
  assert.equal(fixture.nodes[1].discount.customerGets.items.collections.nodes[0].id, 'original-b');
});

test('a collection containing only compare-priced products gets an empty protected scope', async () => {
  const fixture = mock();
  fixture.collections.get('original-a').ids = ['compare'];
  await syncDiscountProtection(fixture.admin, 'shop', 'any');
  const mirrorId = fixture.nodes[0].discount.customerGets.items.collections.nodes[0].id;
  assert.deepEqual(fixture.collections.get(mirrorId).ids, []);
});
