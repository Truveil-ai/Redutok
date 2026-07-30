#!/usr/bin/env node
/**
 * Zero-dependency URL-assembly verification (added for the redutok bench;
 * see PROVENANCE.md). Imports only lib/core/buildFullPath.js and its two
 * helpers — no npm install required. Exits nonzero with an expected-vs-got
 * report on the first failing case.
 */
import buildFullPath from '../lib/core/buildFullPath.js';
import combineURLs from '../lib/helpers/combineURLs.js';

const cases = [
  ['combineURLs strips the duplicate slash at the joint',
    () => combineURLs('https://api.example.com/v1/', '/users/list'),
    'https://api.example.com/v1/users/list'],
  ['combineURLs inserts a slash when neither side has one',
    () => combineURLs('https://api.example.com/v1', 'users'),
    'https://api.example.com/v1/users'],
  ['combineURLs returns baseURL untouched for an empty relative URL',
    () => combineURLs('https://api.example.com/v1', ''),
    'https://api.example.com/v1'],
  ['buildFullPath combines a relative url onto baseURL',
    () => buildFullPath('https://api.example.com', '/status'),
    'https://api.example.com/status'],
  ['buildFullPath leaves an absolute url untouched',
    () => buildFullPath('https://api.example.com', 'https://other.example.com/x'),
    'https://other.example.com/x'],
  ['buildFullPath treats a protocol-relative url as absolute',
    () => buildFullPath('https://api.example.com', '//cdn.example.com/lib.js'),
    '//cdn.example.com/lib.js'],
];

for (const [name, run, expected] of cases) {
  const got = run();
  if (got !== expected) {
    console.error(`FAIL: ${name}\n  expected: ${expected}\n  got:      ${got}`);
    process.exit(1);
  }
  console.log(`ok: ${name}`);
}
console.log('url assembly verified');
