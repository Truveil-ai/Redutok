#!/usr/bin/env node
/**
 * Zero-dependency joint-collapse spec (added for the redutok bench; see
 * PROVENANCE.md). Specifies lib/helpers/normalizeJoin.js, which the library
 * deliberately does not ship: the s05 bench task is to implement it. Until
 * then this script fails on the import itself. Pure ESM, no npm install.
 */
import normalizeJoin from '../lib/helpers/normalizeJoin.js';

const cases = [
  ['normalizeJoin collapses any run of joint slashes to one',
    () => normalizeJoin('https://api.example.com/v1///', '/users/list'),
    'https://api.example.com/v1/users/list'],
  ['normalizeJoin inserts the joint slash when neither side has one',
    () => normalizeJoin('https://api.example.com/v1', 'users'),
    'https://api.example.com/v1/users'],
  ['normalizeJoin leaves the scheme separator alone',
    () => normalizeJoin('https://api.example.com', 'status'),
    'https://api.example.com/status'],
  ['normalizeJoin preserves slashes inside the relative part',
    () => normalizeJoin('https://api.example.com/v1', 'a//b'),
    'https://api.example.com/v1/a//b'],
  ['normalizeJoin returns the base with at most one trailing slash for an empty relative part',
    () => normalizeJoin('https://api.example.com/v1//', ''),
    'https://api.example.com/v1/'],
];

for (const [name, run, expected] of cases) {
  const got = run();
  if (got !== expected) {
    console.error(`FAIL: ${name}\n  expected: ${expected}\n  got:      ${got}`);
    process.exit(1);
  }
  console.log(`ok: ${name}`);
}
console.log('joint collapse verified');
