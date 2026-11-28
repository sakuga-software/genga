import { expect, type BrowserContext } from '@playwright/test';

export type CspWatch = { expectNoViolation: () => void };

/**
 * Records each violation of the Content Security Policy in the pages of the context. The list
 * lives in the test process, so a page load does not empty it.
 */
export async function watchCsp(context: BrowserContext): Promise<CspWatch> {
  const violations: string[] = [];
  await context.exposeBinding('__gengaCspViolation', (_source, text: string) => {
    violations.push(text);
  });
  await context.addInitScript(() => {
    const report = (window as unknown as { __gengaCspViolation: (text: string) => void }).__gengaCspViolation;
    document.addEventListener('securitypolicyviolation', (event) => {
      void report(
        `${location.pathname}: ${event.effectiveDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`,
      );
    });
  });
  return {
    expectNoViolation() {
      expect(violations.splice(0), 'CSP violations').toEqual([]);
    },
  };
}
