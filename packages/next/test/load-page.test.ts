import { beforeEach, describe, expect, it } from 'vitest';
import { nextState } from './next-state';
import { DOC_ID, fakeSource, TOKEN } from './fake-source';
import { loadPage } from '../src/load-page';

beforeEach(() => nextState.reset());

function previewOf(token = TOKEN) {
  nextState.draftMode = true;
  nextState.cookies.set('genga-preview', { value: `${DOC_ID}:${token}`, options: {} });
}

describe('loadPage', () => {
  it('reads the published document outside Draft Mode, without the cookies', async () => {
    const { source, getDraft } = fakeSource();
    nextState.cookies.set('genga-preview', { value: `${DOC_ID}:${TOKEN}`, options: {} });
    const page = await loadPage(source, 'posts', 'hello');
    expect(page.kind === 'document' && page.doc.data).toEqual({ title: 'Published' });
    expect(page.kind === 'document' && page.preview).toBe(false);
    expect(getDraft).not.toHaveBeenCalled();
  });

  it('reads the draft in Draft Mode with a valid token', async () => {
    previewOf();
    const { source } = fakeSource();
    const page = await loadPage(source, 'posts', 'hello');
    expect(page.kind === 'document' && page.doc.data).toEqual({ title: 'Draft' });
    expect(page.kind === 'document' && page.preview).toBe(true);
  });

  it('reads the published document after the token expires', async () => {
    previewOf('expired.token');
    const { source } = fakeSource();
    const page = await loadPage(source, 'posts', 'hello');
    expect(page.kind === 'document' && page.doc.data).toEqual({ title: 'Published' });
  });

  it('reads the published document of another page in a preview', async () => {
    previewOf();
    const { source } = fakeSource();
    const page = await loadPage(source, 'posts', 'other');
    expect(page.kind).toBe('not-found');
  });

  it('answers not found for a slug that no document can have, without a request', async () => {
    const { source, resolveRoute } = fakeSource();
    const page = await loadPage(source, 'posts', '../Hello World');
    expect(page.kind).toBe('not-found');
    expect(resolveRoute).not.toHaveBeenCalled();
  });

  it('ignores a cookie that is not a preview cookie', async () => {
    nextState.draftMode = true;
    nextState.cookies.set('genga-preview', { value: 'not a cookie', options: {} });
    const { source, getDraft } = fakeSource();
    const page = await loadPage(source, 'posts', 'hello');
    expect(page.kind === 'document' && page.preview).toBe(false);
    expect(getDraft).not.toHaveBeenCalled();
  });
});
