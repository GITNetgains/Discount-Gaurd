import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { compareAtExcluded } from '../app/lib/discount-eligibility.ts';
import { discountCoverageRow } from '../app/models/discount-coverage.server.ts';

const source = await readFile(new URL('../app/models/eligibility.server.ts', import.meta.url), 'utf8');
const eligibilityUrl = new URL('../app/lib/discount-eligibility.ts', import.meta.url).href;
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace('"../lib/discount-eligibility"', JSON.stringify(eligibilityUrl));
const { syncAllProducts, syncProduct } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const id = name => `gid://shopify/Product/${name}`;
const variant = (name, compareAtPrice, tags = []) => ({ price: '100.00', compareAtPrice, product: { id: id(name), tags, mapRestricted: null } });

test('ON excludes every set compare-at price; OFF allows compare-at products', () => {
  for (const compareAtPrice of ['150.00', '100.00', '50.00', '0.00']) {
    assert.equal(compareAtExcluded({ price: '100.00', compareAtPrice }), true);
    assert.equal(compareAtExcluded({ price: '100.00', compareAtPrice }, 'off'), false);
  }
  for (const compareAtPrice of [null, '', '  ']) assert.equal(compareAtExcluded({ price: '100.00', compareAtPrice }), false);
});

function mockAdmin() {
  const mutations = [];
  const pages = [
    [variant('normal', null), variant('protected', null), variant('map', null, ['MAP Restricted'])],
    [variant('protected', '100.00'), variant('lower', '50.00'), variant('higher', '150.00'), variant('zero', '0.00')],
  ];
  return {
    mutations,
    graphql: async (query, options) => {
      const vars = options?.variables;
      let data;
      if (query.includes('query FindEligibleCollection')) data = { collectionByIdentifier: { id: 'collection', sources: [{ __typename: 'CollectionConditionsSource', id: 'source' }] } };
      else if (query.includes('query EligibilityVariants')) {
        const page = vars.cursor ? 1 : 0;
        data = { productVariants: { nodes: pages[page], pageInfo: { hasNextPage: page === 0, endCursor: page === 0 ? 'next' : null } } };
      } else if (query.includes('query CollectionMembers')) data = { collection: { products: { nodes: [{ id: id('normal') }, { id: id('protected') }], pageInfo: { hasNextPage: false, endCursor: null } } } };
      else if (query.includes('query ProductInCollection')) data = { product: { id: vars.id, inCollection: true } };
      else if (query.includes('mutation UpdateEligibleSelections')) { mutations.push(vars); data = { collectionUpdate: { userErrors: [] } }; }
      else throw new Error('Unexpected GraphQL operation');
      return { json: async () => ({ data }) };
    },
  };
}

test('full sync excludes a product with a compare-priced sibling on another page and preserves normal products', async () => {
  const admin = mockAdmin();
  const result = await syncAllProducts(admin);
  assert.deepEqual(result, { eligible: 1, excluded: 5, added: 0, removed: 1 });
  assert.deepEqual(admin.mutations[0].remove, [{ productId: id('protected') }]);
});

test('OFF restores compare-priced products but keeps MAP restriction', async () => {
  const admin = mockAdmin();
  const result = await syncAllProducts(admin, 'off');
  assert.deepEqual(result, { eligible: 5, excluded: 1, added: 3, removed: 0 });
  assert.deepEqual(admin.mutations[0].add.map(p => p.productId), [id('lower'), id('higher'), id('zero')]);
});

test('product webhook sync removes newly compare-priced products', async () => {
  const admin = mockAdmin();
  await syncProduct(admin, id('protected'), 'any');
  assert.deepEqual(admin.mutations[0].remove, [{ productId: id('protected') }]);
});

test('coverage never labels broad, extra-collection, or third-party discounts as protected', () => {
  const row = items => discountCoverageRow({ id: 'gid://shopify/DiscountNode/1', discount: { __typename: 'DiscountCodeBasic', customerGets: { items } } }, 'eligible');
  const collectionItems = ids => ({ __typename: 'DiscountCollections', collections: { nodes: ids.map(id => ({ id })), pageInfo: { hasNextPage: false } } });
  assert.equal(row(collectionItems(['eligible'])).covered, true);
  assert.equal(row(collectionItems(['eligible', 'other'])).covered, false);
  assert.equal(row({ __typename: 'AllDiscountItems' }).covered, false);
  assert.equal(discountCoverageRow({ id: '1', discount: { __typename: 'DiscountAutomaticApp' } }, 'eligible').covered, false);
});
