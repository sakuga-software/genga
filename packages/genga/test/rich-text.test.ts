import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isSafeUrl, sanitizeRichText, validate } from '../src';
import { RichText } from '../src/render';
import { paragraph, testConfig } from './helpers';

describe('URL rule', () => {
  it.each([
    'https://example.com',
    'http://a.b',
    'mailto:hello@example.com',
    'tel:+33600000000',
    '/projects/plai',
    '#contact',
    '?q=1',
    'page',
  ])('allows %s', (value) => expect(isSafeUrl(value)).toBe(true));

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'java\tscript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,x',
    'vbscript:x',
    '//evil.example',
    '\\\\evil',
    '',
  ])('rejects %j', (value) => expect(isSafeUrl(value)).toBe(false));
});

describe('rich text', () => {
  it('drops unknown nodes and marks, and links with an unsafe URL', () => {
    const doc = sanitizeRichText({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'ok',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }, { type: 'bold' }],
            },
          ],
        },
        { type: 'iframe', attrs: { src: 'https://evil.example' } },
        { type: 'heading', attrs: { level: 1, onclick: 'x' }, content: [{ type: 'text', text: 'Titre' }] },
      ],
    });
    expect(doc.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'ok', marks: [{ type: 'bold' }] }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Titre' }] },
    ]);
  });

  it('renders safe links and drops unsafe ones at render time', () => {
    const safe = renderToStaticMarkup(createElement(RichText, { value: paragraph('site', 'https://example.com') }));
    expect(safe).toBe(
      '<div><p><a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a></p></div>',
    );
    const unsafe = renderToStaticMarkup(createElement(RichText, { value: paragraph('clic', 'javascript:alert(1)') }));
    expect(unsafe).toBe('<div><p>clic</p></div>');
    const escaped = renderToStaticMarkup(createElement(RichText, { value: paragraph('<img src=x onerror=alert(1)>') }));
    expect(escaped).toContain('&lt;img');
  });

  it('sanitizes rich text at write time', () => {
    const checked = validate(
      testConfig.collections.journal.fields,
      { title: 'x', body: [{ _type: 'rich-text', content: paragraph('a', 'javascript:alert(1)') }] },
      'draft',
      { 'rich-text': { fields: testConfig.blocks[1].fields } },
    );
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      const block = (checked.data.body as { content: { content: { content: { marks?: unknown }[] }[] } }[])[0];
      expect(block.content.content[0].content[0].marks).toBeUndefined();
    }
  });
});
