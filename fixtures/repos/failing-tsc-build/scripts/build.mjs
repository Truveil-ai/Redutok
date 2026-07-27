#!/usr/bin/env node
// Zero-dependency stand-in for a verbose failing TypeScript build, used by the
// pipe distiller e2e (v3 pillar A). It prints a realistic tsc log — many
// "compiled ok" lines plus several genuine `error TSxxxx` diagnostics — and
// exits 1. The build-log profile reads a clean fail verdict from this (the
// primary `error TS` extractor and the secondary bare-`error` extractor agree),
// so the output distills to the verdict plus the first error rather than
// serving raw. Output is fully deterministic (no timestamps, no random) so a
// vanilla run and the pipe's captured run are byte-for-byte identical, which is
// what the zoom byte-equality assertion depends on.

const modules = [
  'index', 'config', 'logger', 'router', 'store', 'cache', 'queue', 'worker',
  'client', 'server', 'session', 'auth', 'crypto', 'codec', 'stream', 'buffer',
  'parser', 'lexer', 'emitter', 'walker', 'binder', 'checker', 'linker', 'loader',
];

process.stdout.write('> tsc --build tsconfig.json\n\n');
for (const name of modules) {
  process.stdout.write(`[compile] src/${name}.ts — ok\n`);
}
process.stdout.write('\n');

const diagnostics = [
  "src/checker.ts(142,17): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  "src/binder.ts(88,5): error TS2322: Type 'undefined' is not assignable to type 'Symbol'.",
  "src/router.ts(53,29): error TS2554: Expected 2 arguments, but got 1.",
];
for (const line of diagnostics) {
  process.stdout.write(line + '\n');
}

process.stdout.write(`\nFound ${diagnostics.length} errors in 3 files.\n`);
process.exit(1);
