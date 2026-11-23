import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { BlockDefinition } from '../config';
import type { BlockData } from '../fields/types';

type BoundaryProps = { type: string; preview: boolean; children: ReactNode };

class BlockBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[genga] The block "${this.props.type}" failed to render.`, error, info.componentStack);
  }

  componentDidUpdate(previous: BoundaryProps) {
    if (this.state.failed && previous.children !== this.props.children && this.props.preview) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (!this.props.preview) return null;
    return (
      <div role="alert" style={{ padding: '1rem', border: '1px dashed #ff6b50', color: '#ff6b50', borderRadius: 8 }}>
        Le bloc « {this.props.type} » ne peut pas s’afficher. Vérifiez ses champs.
      </div>
    );
  }
}

export type RenderBlocksProps = {
  blocks: BlockData[] | null | undefined;
  // oxlint-disable-next-line typescript/no-explicit-any -- each block has its own props type.
  registry: BlockDefinition<any>[];
  /** Adds `data-genga-block` so the editor can select a block with a click. */
  preview?: boolean;
  className?: string;
};

/**
 * Renders a list of blocks with the site components. Each block renders in its own
 * error boundary. Unknown block types and blocks without a component render nothing.
 */
export function RenderBlocks({ blocks, registry, preview = false, className }: RenderBlocksProps) {
  if (!blocks?.length) return null;
  const byType = new Map(registry.map((block) => [block.type, block]));
  const items = blocks.map((block, index) => {
    const BlockComponent = byType.get(block._type)?.component;
    if (!BlockComponent) return null;
    return (
      <div
        key={block._id}
        data-genga-block={preview ? index : undefined}
        data-genga-block-id={preview ? block._id : undefined}
        data-genga-block-type={block._type}
      >
        <BlockBoundary type={block._type} preview={preview}>
          <BlockComponent {...block} />
        </BlockBoundary>
      </div>
    );
  });
  return <div className={className}>{items}</div>;
}
