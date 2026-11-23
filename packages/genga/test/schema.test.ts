import { describe, expect, it } from 'vitest';
import { blockSchemas, tolerantRead, validate } from '../src';
import { testConfig } from './helpers';

const fields = testConfig.collections.journal.fields;
const blocks = blockSchemas(testConfig);

describe('tolerant read', () => {
  it('drops unknown keys and fills missing keys with defaults', () => {
    const data = tolerantRead(fields, { title: 'Ancien', removedField: 42 }, blocks);
    expect(data).toEqual({
      title: 'Ancien',
      slug: '',
      excerpt: '',
      cover: null,
      publishedDate: '',
      tags: [],
      body: [],
    });
  });

  it('replaces a value of the wrong type with the default', () => {
    const data = tolerantRead(fields, { title: 12, tags: 'pas une liste', cover: { id: 1 } }, blocks);
    expect(data.title).toBe('');
    expect(data.tags).toEqual([]);
    expect(data.cover).toBeNull();
  });

  it('keeps unknown block types in the data and repairs known blocks', () => {
    const data = tolerantRead(
      fields,
      { body: [{ _type: 'old-block', _id: 'b1', value: 1 }, { _type: 'image', caption: 3 }, 'garbage'] },
      blocks,
    );
    const body = data.body as Record<string, unknown>[];
    expect(body[0]).toMatchObject({ _type: 'old-block', _id: 'b1' });
    expect(body[1]).toMatchObject({ _type: 'image', image: null, caption: '' });
    expect(body[1]._id).toMatch(/[0-9a-f-]{36}/);
    expect(body).toHaveLength(2);
  });

  it('never throws on garbage', () => {
    expect(() => tolerantRead(fields, 'garbage', blocks)).not.toThrow();
    expect(() => tolerantRead(fields, null, blocks)).not.toThrow();
  });

  it('checks required fields only at publish', () => {
    expect(validate(fields, { title: '' }, 'draft', blocks).ok).toBe(true);
    const result = validate(fields, { title: '' }, 'publish', blocks);
    expect(result.ok).toBe(false);
    expect(validate(fields, { title: 'x', body: [{ _type: 'nope' }] }, 'draft', blocks).ok).toBe(false);
  });
});
