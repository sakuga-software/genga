import { describe, expect, it } from 'vitest';
import { moveItem } from '../src/admin/editor/block-order';

describe('moveItem', () => {
  const items = ['a', 'b', 'c', 'd'];

  it('moves an item down to the position of the target', () => {
    expect(moveItem(items, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an item up to the position of the target', () => {
    expect(moveItem(items, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('moves to the first and to the last position', () => {
    expect(moveItem(items, 2, 0)).toEqual(['c', 'a', 'b', 'd']);
    expect(moveItem(items, 1, 3)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('keeps the order for a drop on the same position or out of range, and does not change the input', () => {
    expect(moveItem(items, 1, 1)).toEqual(items);
    expect(moveItem(items, -1, 2)).toEqual(items);
    expect(moveItem(items, 1, 4)).toEqual(items);
    expect(items).toEqual(['a', 'b', 'c', 'd']);
  });
});
