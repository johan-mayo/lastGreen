/** Returns the Next.js basePath (e.g. "/lastgreen") or empty string. */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

/** Prefix a path with the basePath for use in fetch() or src attributes. */
export function withBasePath(path: string): string {
  return `${basePath}${path}`;
}
