// The id of the running build: a content hash written into index.html by the production build
// (tools/build/versioning.ts). Empty in development and outside a browser.

let cached: string | null = null;

export function buildId(): string {
  if (cached === null) {
    cached = typeof document === 'undefined' ? '' : (document.querySelector<HTMLMetaElement>('meta[name="boombuds-build"]')?.content ?? '');
  }
  return cached;
}
