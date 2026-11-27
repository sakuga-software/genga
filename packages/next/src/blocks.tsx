import type { BlockData, BlockDefinition, FieldValues, GengaConfig } from 'genga';
import { Suspense, type ComponentType } from 'react';
import { BlockBoundary, LiveBlock } from './client';

/** The props of the component of a block: its field values, `_id` and `_type`. */
export type BlockProps<B extends Pick<BlockDefinition, 'fields'>> = FieldValues<B['fields']> & {
  _id: string;
  _type: string;
};

// oxlint-disable-next-line typescript/no-explicit-any -- each block has its own props type.
export type BlockRegistry = Readonly<Record<string, ComponentType<any>>>;

/**
 * Maps the block types of the config to React components. A key that is not a block type of
 * the config throws, so a typo does not hide a block. A block type without a component
 * renders nothing on the site and a notice in a preview.
 */
export function defineBlockComponents<const R extends BlockRegistry>(
  config: Pick<GengaConfig, 'blocks'>,
  components: R,
): R {
  const types = new Set(config.blocks.map((block) => block.type));
  const unknown = Object.keys(components).filter((type) => !types.has(type));
  if (unknown.length) {
    throw new Error(`Genga: ${unknown.map((type) => `"${type}"`).join(', ')} is not a block type of the config.`);
  }
  return Object.freeze({ ...components });
}

const CLIENT_REFERENCE = Symbol.for('react.client.reference');

/** True for a component of a `'use client'` module, seen from a Server Component. */
function isClientComponent(component: unknown): boolean {
  return (component as { $$typeof?: symbol } | null)?.$$typeof === CLIENT_REFERENCE;
}

export type BlocksProps = {
  blocks: readonly BlockData[] | null | undefined;
  registry: BlockRegistry;
  /** True in a preview: the editor can select each block, and client blocks follow each change. */
  preview?: boolean;
  className?: string;
};

/**
 * Renders a list of blocks, in order, each in its own error boundary.
 *
 * In a preview, a block whose component is a Client Component (`'use client'`) renders the
 * draft of the editor at each change. A Server Component block shows the draft after each
 * autosave, when `<GengaPreview>` refreshes the page.
 */
export function Blocks({ blocks, registry, preview = false, className }: BlocksProps) {
  if (!blocks?.length) return null;
  return (
    <div className={className}>
      {blocks.map((block, index) => {
        const BlockComponent = registry[block._type];
        if (!BlockComponent && !preview) return null;
        let content = null;
        if (!BlockComponent) content = <p data-genga-block-missing="">No component for the block “{block._type}”.</p>;
        else if (preview && isClientComponent(BlockComponent))
          content = <LiveBlock component={BlockComponent} block={block} />;
        else content = <BlockComponent {...block} />;
        return (
          <div
            key={block._id}
            data-genga-block-type={block._type}
            data-genga-block={preview ? index : undefined}
            data-genga-block-id={preview ? block._id : undefined}
          >
            <BlockBoundary type={block._type} preview={preview}>
              <Suspense fallback={null}>{content}</Suspense>
            </BlockBoundary>
          </div>
        );
      })}
    </div>
  );
}
