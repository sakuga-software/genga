import { expect, type BrowserContext, type Page } from '@playwright/test';

/** Records each violation of the Content Security Policy in the pages of the context. */
export async function watchCsp(context: BrowserContext) {
  await context.addInitScript(() => {
    const store = window as unknown as { __cspViolations: string[] };
    store.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      store.__cspViolations.push(
        `${event.effectiveDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`,
      );
    });
  });
}

/** Fails when the page saw a violation of the Content Security Policy. */
export async function expectNoCspViolation(page: Page) {
  const violations = await page.evaluate(
    () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
  );
  expect(violations, 'CSP violations').toEqual([]);
}
