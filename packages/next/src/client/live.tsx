import type { PublicDocument } from 'genga/remote';
import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { useDraft, useDraftBlock } from './store';

/**
 * Returns the document to render in a Client Component. In a preview, it returns the draft
 * that the editor sends at each change. Elsewhere it returns `doc`.
 */
export function usePreviewData<T>(doc: PublicDocument<T>, preview: boolean): PublicDocument<T> {
  const draft = useDraft();
  return preview && draft?.documentId === doc.id ? { ...doc, data: draft.data as T } : doc;
}

type LiveBlockProps = {
  // oxlint-disable-next-line typescript/no-explicit-any -- each block has its own props type.
  component: ComponentType<any>;
  block: { _id: string; _type: string } & Record<string, unknown>;
};

/** A client block in a preview: it renders the fields of the last draft. */
export function LiveBlock({ component: BlockComponent, block }: LiveBlockProps) {
  const live = useDraftBlock(block._id);
  return <BlockComponent {...(live ?? block)} />;
}

type BoundaryProps = { type: string; preview: boolean; children: ReactNode };

/** Keeps the page up when one block fails. In a preview it shows a notice in place of the block. */
export class BlockBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[genga] The block "${this.props.type}" failed to render.`, error, info.componentStack);
  }

  componentDidUpdate(previous: BoundaryProps) {
    if (this.state.failed && this.props.preview && previous.children !== this.props.children) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (!this.props.preview) return null;
    return (
      <div role="alert" data-genga-block-error="">
        The block “{this.props.type}” cannot render. Check its fields.
      </div>
    );
  }
}
