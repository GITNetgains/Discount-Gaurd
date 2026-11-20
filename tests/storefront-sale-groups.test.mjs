import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveSaleGroups as rawLiveSaleGroups } from '../app/lib/storefront-sale-groups.ts';

const liveSaleGroups = (...args) =>
  rawLiveSaleGroups(...args).map(({ name, productIds }) => ({ name, productIds }));

test('includes each live sale start and end time', () => {
  const [group] = rawLiveSaleGroups([sale('Dated', 0, ['a'])], now);
  assert.equal(group.startsAt, '2026-11-18T09:00:00.000Z');
  assert.equal(group.endsAt, '2026-11-18T11:00:00.000Z');
});

const now = new Date('2026-11-18T10:00:00Z');
const sale = (name, position, ids, overrides = {}) => ({
  name, position,
  startsAt: new Date('2026-11-18T09:00:00Z'),
  endsAt: new Date('2026-11-18T11:00:00Z'),
  products: ids.map((productId, position) => ({ productId, position })),
  ...overrides,
});

test('uses sheet order for equal start times and places shared products under the first live sale only', () => {
  const input = [sale('Second', 1, ['shared', 'b']), sale('First', 0, ['a', 'shared'])];
  assert.deepEqual(liveSaleGroups(input, now), [
    { name: 'First', productIds: ['a', 'shared'] },
    { name: 'Second', productIds: ['b'] },
  ]);
  assert.equal(input[0].name, 'Second');
});

test('shows recently started sales first, including shared products, regardless of sheet order', () => {
  const input = [
    sale('Older', 0, ['shared', 'old'], { startsAt: new Date('2026-11-17T09:00:00Z') }),
    sale('Today earlier', 1, ['early'], { startsAt: new Date('2026-11-18T08:00:00Z') }),
    sale('Today newest', 2, ['new', 'shared']),
  ];
  assert.deepEqual(liveSaleGroups(input, now), [
    { name: 'Today newest', productIds: ['new', 'shared'] },
    { name: 'Today earlier', productIds: ['early'] },
    { name: 'Older', productIds: ['old'] },
  ]);
  assert.equal(input[0].name, 'Older');
});

test('starts inclusively, ends exclusively, and excludes invalid or undated sales', () => {
  assert.deepEqual(liveSaleGroups([
    sale('Starting', 0, ['a'], { startsAt: now }),
    sale('Ended', 1, ['b'], { endsAt: now }),
    sale('Upcoming', 2, ['c'], { startsAt: new Date(now.getTime() + 1) }),
    sale('Undated', 3, ['d'], { endsAt: null }),
    sale('Invalid', 4, ['e'], { endsAt: new Date('2026-11-17') }),
  ], now), [{ name: 'Starting', productIds: ['a'] }]);
});

test('omits empty groups and preserves product position', () => {
  const first = sale('First', 0, ['a', 'b']);
  first.products.reverse();
  assert.deepEqual(liveSaleGroups([first, sale('Duplicate', 1, ['a'])], now), [
    { name: 'First', productIds: ['a', 'b'] },
  ]);
});
