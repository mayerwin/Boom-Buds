// Modules made by the build (tools/build/versioning.ts).

declare module 'virtual:boombuds-data' {
  /** Content hash of every file of public/data by its path there (empty in development). */
  const hashes: Record<string, string>;
  export default hashes;
}
