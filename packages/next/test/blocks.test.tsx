import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Blocks, defineBlockComponents } from '../src/blocks';
import { LiveBlock } from '../src/client/live';
import { blocksOf } from '../src/client/store';

const config = {
  blocks: [
    { type: 'hero', label: 'Hero', fields: {} },
    { type: 'quote', label: 'Quote', fields: {} },
  ],
};

function Hero({ title }: { title: string }) {
  return <h2>{title}</h2>;
}

/** A component as a Server Component sees a `'use client'` export. */
function asClientReference<T extends object>(component: T): T {
  return Object.assign(component, { $$typeof: Symbol.for('react.client.reference') });
}

const hero = { _id: 'b1', _type: 'hero', title: 'Saved title' };

describe('defineBlockComponents', () => {
  it('refuses a key that is not a block type', () => {
    expect(() => defineBlockComponents(config, { heroo: Hero })).toThrow('"heroo" is not a block type');
  });

  it('returns the components', () => {
    expect(defineBlockComponents(config, { hero: Hero }).hero).toBe(Hero);
  });
});

describe('Blocks', () => {
  it('renders the blocks with their type on the public site', () => {
    const html = renderToString(<Blocks blocks={[hero]} registry={{ hero: Hero }} />);
    expect(html).toContain('<h2>Saved title</h2>');
    expect(html).toContain('data-genga-block-type="hero"');
    expect(html).not.toContain('data-genga-block-id');
  });

  it('marks the blocks for the editor in a preview', () => {
    const html = renderToString(<Blocks blocks={[hero]} registry={{ hero: Hero }} preview />);
    expect(html).toContain('data-genga-block="0"');
    expect(html).toContain('data-genga-block-id="b1"');
  });

  it('renders nothing for a block without a component, and a notice in a preview', () => {
    const missing = [{ _id: 'b2', _type: 'quote' }];
    expect(renderToString(<Blocks blocks={missing} registry={{}} />)).toBe('<div></div>');
    expect(renderToString(<Blocks blocks={missing} registry={{}} preview />)).toContain('No component for the block');
  });

  it('gives a client block to LiveBlock in a preview only', () => {
    const ClientHero = asClientReference(function ClientHero(props: { title: string }) {
      return <Hero {...props} />;
    });
    const live = (<Blocks blocks={[hero]} registry={{ hero: ClientHero }} preview />) as ReactElement<{
      children: ReactElement;
    }>;
    const tree = Blocks(live.props as never) as ReactElement<{ children: ReactElement[] }>;
    const wrapper = tree.props.children[0] as ReactElement<{ children: ReactElement<{ children: ReactElement }> }>;
    const suspense = wrapper.props.children.props.children as ReactElement<{ children: ReactElement }>;
    expect(suspense.props.children.type).toBe(LiveBlock);
    const published = Blocks({ blocks: [hero], registry: { hero: ClientHero } }) as ReactElement<{
      children: ReactElement[];
    }>;
    const publishedWrapper = published.props.children[0] as typeof wrapper;
    expect((publishedWrapper.props.children.props.children as typeof suspense).props.children.type).toBe(ClientHero);
  });
});

describe('blocksOf', () => {
  it('finds the blocks of a draft at every depth', () => {
    const nested = { _id: 'b3', _type: 'quote', text: 'Inner' };
    const index = blocksOf({ title: 'x', body: [{ ...hero, title: 'Typed title' }], group: { items: [nested] } });
    expect(index.get('b1')?.title).toBe('Typed title');
    expect(index.get('b3')).toBe(nested);
    expect(index.has('missing')).toBe(false);
  });
});
