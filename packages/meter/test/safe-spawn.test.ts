import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveExecutable, spawnSafely, unwrapCmdShim } from '../src/safe-spawn.js';

describe('unwrapCmdShim', () => {
  // Captured verbatim from an npm-generated claude.cmd shim (npm i -g
  // @anthropic-ai/claude-code on Windows).
  const REAL_SHIM = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  ].join('\r\n');

  it('extracts the wrapped executable path relative to the shim directory', () => {
    // unwrapCmdShim always parses Windows path syntax (a .cmd shim is
    // Windows-only), so the expected value must be built the same way
    // regardless of which platform this test happens to run on.
    const resolved = unwrapCmdShim('C:\\Users\\me\\npm\\claude.cmd', REAL_SHIM);
    expect(resolved).toBe(
      path.win32.join('C:\\Users\\me\\npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    );
  });

  it('returns undefined for a shim that does not match the fixed npm pattern', () => {
    expect(unwrapCmdShim('C:\\x\\custom.cmd', '@echo off\r\nnode "%~dp0custom.js" %*\r\n')).toBeUndefined();
  });
});

describe('resolveExecutable', () => {
  it('is a no-op on non-Windows platforms, since PATH lookup needs no shell there', () => {
    expect(resolveExecutable('claude', 'linux')).toEqual({ file: 'claude' });
    expect(resolveExecutable('claude', 'darwin')).toEqual({ file: 'claude' });
  });

  it.runIf(process.platform === 'win32')(
    'resolves a real command to a directly-executable .exe on Windows',
    () => {
      const resolved = resolveExecutable('node');
      expect(resolved.file.toLowerCase()).toMatch(/\.exe$/);
    },
  );

  it.runIf(process.platform === 'win32')(
    'throws rather than falling back to a shell when nothing resolves',
    () => {
      expect(() => resolveExecutable('this-command-does-not-exist-anywhere-xyz')).toThrow(/not found on PATH/);
    },
  );
});

describe('spawnSafely delivers a multi-word argument intact, without shell:true', () => {
  it.runIf(process.platform === 'win32')(
    'the spawned child sees the multi-word prompt as one argv element, and DEP0190 never fires',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-safe-spawn-'));
      const echoArgvScript = path.join(dir, 'echo-argv.mjs');
      writeFileSync(echoArgvScript, 'console.log(JSON.stringify(process.argv.slice(2)));\n');

      const warnings: string[] = [];
      const onWarning = (w: Error & { code?: string }) => {
        warnings.push(w.code ?? w.message);
      };
      process.on('warning', onWarning);

      try {
        const multiWordPrompt = 'Describe the Counter class contract.';
        const child = spawnSafely('node', [echoArgvScript, '-p', multiWordPrompt, '--model', 'claude-sonnet-5'], {
          windowsHide: true,
        });
        const output = await new Promise<string>((resolve, reject) => {
          let out = '';
          child.stdout?.on('data', (c) => (out += c));
          child.on('error', reject);
          child.on('close', () => resolve(out.trim()));
        });

        const argv = JSON.parse(output) as string[];
        expect(argv).toEqual(['-p', multiWordPrompt, '--model', 'claude-sonnet-5']);
        expect(warnings).not.toContain('DEP0190');
      } finally {
        process.off('warning', onWarning);
      }
    },
  );
});
