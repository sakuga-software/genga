import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Tooltip } from '@heroui/react';
import { ExternalLink, Monitor, RotateCw, Smartphone } from 'lucide-react';
import { isTrustedMessage } from '../../preview/bridge';
import type { PreviewMessage } from '../../types';
import { SegmentedControl } from '../ui/segmented-control';

type PreviewPaneProps = {
  documentId: string;
  src: string;
  /** The origin of the frame. Default: the origin of the admin. */
  targetOrigin?: string | null;
  /** Gets a fresh frame URL before a reload, for example with a new preview token. */
  refreshSrc?: () => Promise<unknown>;
  /** The populated draft. The pane posts it to the frame after each change. */
  data: Record<string, unknown> | null;
  selectedBlockId: string | null;
  onSelectBlock: (blockId: string) => void;
};

/** The real site route in a frame. It updates at each change without a reload. */
export function PreviewPane({
  documentId,
  src,
  targetOrigin,
  refreshSrc,
  data,
  selectedBlockId,
  onSelectBlock,
}: PreviewPaneProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [ready, setReady] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const latestData = useRef(data);
  const selectRef = useRef(onSelectBlock);

  useEffect(() => {
    latestData.current = data;
    selectRef.current = onSelectBlock;
  });

  const post = useCallback(
    (message: PreviewMessage) => {
      frame.current?.contentWindow?.postMessage(message, targetOrigin ?? window.location.origin);
    },
    [targetOrigin],
  );

  async function reload() {
    setReady(false);
    await refreshSrc?.().catch(() => null);
    setReloadKey((key) => key + 1);
  }

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const expected = {
        origin: targetOrigin ?? window.location.origin,
        source: frame.current?.contentWindow ?? null,
        documentId,
      };
      if (!isTrustedMessage(event, expected)) return;
      if (event.data.type === 'genga:ready') {
        setReady(true);
        if (latestData.current) post({ type: 'genga:draft', documentId, data: latestData.current });
      }
      if (event.data.type === 'genga:select') selectRef.current(event.data.blockId);
    };
    window.addEventListener('message', onMessage);
    // The frame can finish its load before this listener exists and miss our answer to its `genga:ready`.
    // `genga:hello` asks a frame that is already connected to send `genga:ready` again.
    post({ type: 'genga:hello', documentId });
    return () => window.removeEventListener('message', onMessage);
  }, [documentId, targetOrigin, post]);

  useEffect(() => {
    if (!ready || !data) return;
    const handle = window.requestAnimationFrame(() => post({ type: 'genga:draft', documentId, data }));
    return () => window.cancelAnimationFrame(handle);
  }, [data, ready, documentId, post]);

  useEffect(() => {
    if (ready) post({ type: 'genga:focus', documentId, blockId: selectedBlockId });
  }, [selectedBlockId, ready, documentId, post]);

  return (
    <section aria-label="Aperçu" className="flex h-full min-h-0 flex-col bg-[var(--surface-secondary)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <SegmentedControl
          label="Largeur de l’aperçu"
          value={device}
          onChange={setDevice}
          options={[
            { id: 'desktop', label: 'Ordinateur', icon: <Monitor aria-hidden className="size-4" /> },
            { id: 'mobile', label: 'Mobile', icon: <Smartphone aria-hidden className="size-4" /> },
          ]}
        />
        <span className="genga-mono ml-1 truncate text-xs text-[var(--muted)]">{src.split('?')[0]}</span>
        <div className="ml-auto flex gap-1">
          <Tooltip delay={300}>
            <Button isIconOnly size="sm" variant="ghost" aria-label="Recharger l’aperçu" onPress={() => void reload()}>
              <RotateCw aria-hidden className="size-4" />
            </Button>
            <Tooltip.Content>Recharger</Tooltip.Content>
          </Tooltip>
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex size-8 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-tertiary)] hover:text-[var(--foreground)]"
            aria-label="Ouvrir l’aperçu dans un nouvel onglet"
          >
            <ExternalLink aria-hidden className="size-4" />
          </a>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 justify-center overflow-auto p-3">
        <iframe
          key={reloadKey}
          ref={frame}
          src={src}
          title="Aperçu de la page sur le site"
          onLoad={() => post({ type: 'genga:hello', documentId })}
          className="h-full rounded-lg border border-[var(--border)] bg-[#050505] transition-[width] duration-300"
          style={{ width: device === 'mobile' ? 390 : '100%' }}
        />
      </div>
    </section>
  );
}
