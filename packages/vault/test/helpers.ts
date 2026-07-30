import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Monorepo root, resolved from this test file's location. */
export const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Test corpus source: long enough that a skeleton is much smaller than the
 * raw file, with symbol names unusual enough that ask questions rank it.
 */
export const URL_BUILDER_SOURCE = `/**
 * Address assembly helpers for the vault test corpus. The shapes mirror the
 * axios fixture's buildFullPath/combineURLs internals in miniature, so the
 * same kind of question exercises the same explore path.
 */

export interface QueryParams {
  [key: string]: string;
}

/** True when the candidate already names a scheme, so no base applies. */
export function segmentIsAbsolute(candidate: string): boolean {
  return /^([a-z][a-z\\d+\\-.]*:)?\\/\\//i.test(candidate);
}

/** Join base and relative segment with exactly one slash between them. */
export function combineSegments(base: string, relative: string): string {
  if (relative === '') return base;
  return base.replace(/\\/+$/, '') + '/' + relative.replace(/^\\/+/, '');
}

/** Encode query params into a canonical, deterministic search string. */
export function encodeQuery(params: QueryParams): string {
  const keys = Object.keys(params).sort();
  const pairs: string[] = [];
  for (const key of keys) {
    const value = params[key] ?? '';
    pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
  }
  return pairs.length === 0 ? '' : '?' + pairs.join('&');
}

/**
 * The full assembly: absolute segments win outright, otherwise the base and
 * segment are combined, and the encoded query is appended at the end.
 */
export function assembleAddress(base: string, relative: string, params: QueryParams): string {
  const stem = segmentIsAbsolute(relative) ? relative : combineSegments(base, relative);
  return stem + encodeQuery(params);
}
`;

/** Planted secret for the redaction guardrail test; composed so the literal
 * never appears verbatim in the repository itself. */
export const AWS_KEY_LITERAL = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

export const CREDENTIALS_SOURCE = `/** Deliberately planted credentials sample for the redaction guardrail. */

export const uploadKey = '${AWS_KEY_LITERAL}';

export const uploadRegion = 'us-east-1';

/** Where uploadTarget points uploads, keyed by the uploadKey credentials. */
export function uploadTarget(bucket: string): string {
  return 'https://' + bucket + '.example-storage.test/';
}
`;

export interface TempCorpus {
  root: string;
  cleanup: () => void;
}

/**
 * A minimal initialized corpus: source files plus the .dcp state directory
 * with the config.json that redutok init writes (profilesDir pointing at the
 * monorepo's shipped profiles). Store and audit trail are created on mount.
 */
export function makeCorpusDir(): TempCorpus {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vault-corpus-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'url-builder.ts'), URL_BUILDER_SOURCE, 'utf8');
  writeFileSync(path.join(root, 'src', 'sample-credentials.ts'), CREDENTIALS_SOURCE, 'utf8');
  mkdirSync(path.join(root, '.dcp'));
  writeFileSync(
    path.join(root, '.dcp', 'config.json'),
    JSON.stringify({ port: 48642, profilesDir: path.join(monorepoRoot, 'profiles') }, null, 2) + '\n',
    'utf8',
  );
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
  };
}
