import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectBridge, connectPreview, isTrustedMessage, previewToken, readPreviewParams } from '../src/preview';

const ADMIN = 'https://cms.example.com';
const DOC = '6f1c2a5e-3b1d-4c55-9f0e-2a7d8c9b0e11';

describe('isTrustedMessage', () => {
  const parent = {};
  const expected = { origin: ADMIN, source: parent, documentId: DOC };
  const draft = { type: 'genga:draft', documentId: DOC, data: {} };

  it('accepts a Genga message from the expected window and origin', () => {
    expect(isTrustedMessage({ origin: ADMIN, source: parent, data: draft }, expected)).toBe(true);
  });

  it.each([
    ['another origin', { origin: 'https://evil.example', source: parent, data: draft }],
    ['a sibling origin', { origin: 'https://cms.example.com:8443', source: parent, data: draft }],
    ['another window', { origin: ADMIN, source: {}, data: draft }],
    ['no window', { origin: ADMIN, source: null, data: draft }],
    ['another document', { origin: ADMIN, source: parent, data: { ...draft, documentId: 'other' } }],
    ['a message without a type', { origin: ADMIN, source: parent, data: { documentId: DOC } }],
    ['a string', { origin: ADMIN, source: parent, data: 'genga:draft' }],
  ])('rejects %s', (_label, event) => {
    expect(isTrustedMessage(event, expected)).toBe(false);
  });

  it('never trusts the wildcard origin', () => {
    expect(isTrustedMessage({ origin: '*', source: parent, data: draft }, { ...expected, origin: '*' })).toBe(false);
  });
});

type Listener = (event: unknown) => void;

function fakeFrame(url: string) {
  const listeners = new Map<string, Listener>();
  const parent = { postMessage: vi.fn() };
  const win = {
    parent,
    location: new URL(url),
    history: {
      state: { key: 'kept' },
      replaceState: vi.fn((state: unknown, _title: string, next: string) => {
        win.location = new URL(next);
        win.history.state = state as { key: string };
      }),
    },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', {
    getElementById: () => null,
    createElement: () => ({}),
    head: { append: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
    querySelector: () => null,
  });
  return {
    parent,
    listeners,
    send: (origin: string, data: unknown, source: unknown = parent) =>
      listeners.get('message')?.({ origin, source, data }),
  };
}

describe('connectBridge', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts to the exact admin origin and applies only its drafts', () => {
    const frame = fakeFrame('https://site.example/blog/a');
    const onDraft = vi.fn();
    const disconnect = connectBridge({ documentId: DOC, adminOrigin: `${ADMIN}/`, onDraft });

    expect(frame.parent.postMessage).toHaveBeenCalledWith({ type: 'genga:ready', documentId: DOC }, ADMIN);
    frame.send('https://evil.example', { type: 'genga:draft', documentId: DOC, data: { title: 'evil' } });
    frame.send(ADMIN, { type: 'genga:draft', documentId: DOC, data: { title: 'other window' } }, {});
    frame.send(ADMIN, { type: 'genga:draft', documentId: DOC, data: { title: 'ok' } });
    expect(onDraft).toHaveBeenCalledTimes(1);
    expect(onDraft).toHaveBeenCalledWith({ title: 'ok' });

    disconnect();
    expect(frame.listeners.has('message')).toBe(false);
  });

  it('refuses an admin origin that is not an origin', () => {
    fakeFrame('https://site.example/');
    expect(() => connectBridge({ documentId: DOC, adminOrigin: '*', onDraft: () => {} })).toThrow();
    expect(() =>
      connectBridge({ documentId: DOC, adminOrigin: 'https://cms.example.com/path', onDraft: () => {} }),
    ).toThrow();
  });
});

describe('connectPreview', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does nothing outside a preview URL', () => {
    fakeFrame('https://site.example/blog/a');
    expect(connectPreview({ adminOrigin: ADMIN, onDraft: () => {} }).documentId).toBeNull();
  });

  it('loads the first draft with the token, then keeps the live drafts', async () => {
    const frame = fakeFrame(`https://site.example/blog/a?genga-preview=${DOC}&genga-token=abc.def`);
    let answer: (value: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const onDraft = vi.fn();

    const connection = connectPreview({ adminOrigin: ADMIN, onDraft });
    expect(connection.documentId).toBe(DOC);
    expect(fetchMock).toHaveBeenCalledWith(`${ADMIN}/api/v1/preview/${DOC}?token=abc.def`, expect.anything());

    frame.send(ADMIN, { type: 'genga:draft', documentId: DOC, data: { title: 'live' } });
    answer(new Response(JSON.stringify({ document: { data: { title: 'stale' } } })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onDraft.mock.calls.map(([data]) => data.title)).toEqual(['live']);
    connection.disconnect();
  });
});

describe('preview tokens in the frame', () => {
  afterEach(() => vi.unstubAllGlobals());
  const OTHER = '0d9e7c55-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

  it('moves the token from the address bar to memory, and keeps the other parameters', () => {
    const frame = fakeFrame(`https://site.example/blog/a?genga-preview=${OTHER}&genga-token=first.token&x=1`);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const connection = connectPreview({ adminOrigin: ADMIN, onDraft: () => {} });

    const win = window as unknown as { location: URL; history: { replaceState: ReturnType<typeof vi.fn> } };
    expect(win.history.replaceState).toHaveBeenCalledWith({ key: 'kept' }, '', expect.any(String));
    expect(win.location.href).toBe(`https://site.example/blog/a?genga-preview=${OTHER}&x=1`);
    expect(connection.token()).toBe('first.token');
    expect(previewToken(OTHER)).toBe('first.token');
    expect(readPreviewParams(win.location.href)).toEqual({ documentId: OTHER, token: 'first.token' });
    expect(frame.parent.postMessage).toHaveBeenCalledWith({ type: 'genga:ready', documentId: OTHER }, ADMIN);
    connection.disconnect();
  });

  it('takes a fresh token and a saved notice from the admin only', () => {
    const frame = fakeFrame(`https://site.example/blog/a?genga-preview=${DOC}&genga-token=old.token`);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const onToken = vi.fn();
    const onSaved = vi.fn();
    const connection = connectPreview({ adminOrigin: ADMIN, onDraft: () => {}, onToken, onSaved });

    frame.send('https://evil.example', { type: 'genga:token', documentId: DOC, token: 'evil.token' });
    frame.send(ADMIN, { type: 'genga:token', documentId: 'another', token: 'other.token' });
    expect(connection.token()).toBe('old.token');
    frame.send(ADMIN, { type: 'genga:token', documentId: DOC, token: 'new.token' });
    expect(connection.token()).toBe('new.token');
    expect(onToken).toHaveBeenCalledWith('new.token', DOC);

    frame.send('https://evil.example', { type: 'genga:saved', documentId: DOC, draftRev: 9 });
    frame.send(ADMIN, { type: 'genga:saved', documentId: DOC, draftRev: 'x' });
    frame.send(ADMIN, { type: 'genga:saved', documentId: DOC, draftRev: 4 });
    expect(onSaved.mock.calls).toEqual([[4, DOC]]);
    connection.disconnect();
  });
});
