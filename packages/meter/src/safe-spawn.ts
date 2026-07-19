import { execFileSync, spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Safe cross-platform process spawning, architecture note: bench live mode.
 *
 * Node requires shell:true to invoke a .cmd/.bat file on Windows (spawning
 * one directly throws EINVAL), but shell:true does not escape an args array:
 * a multi-word element like a bench task prompt gets word-split by cmd.exe
 * before the child ever sees it. The fix is to never use shell:true: resolve
 * the PATH command to a directly-executable target (an .exe, or the real
 * binary an npm-generated .cmd shim wraps) and spawn that with shell:false,
 * where Node's own argument passing is exact.
 */

export interface ResolvedExecutable {
  file: string;
}

/**
 * Extracts the wrapped executable path from an npm-generated .cmd shim, e.g.
 *   "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
 * Returns undefined when the shim does not match this fixed one-line
 * pattern; callers must not guess further, only refuse.
 */
export function unwrapCmdShim(shimPath: string, contents: string): string | undefined {
  const match = /"%dp0%\\(.+?)"\s+%\*/.exec(contents);
  if (match?.[1] === undefined) return undefined;
  // shimPath and the captured group are always Windows paths (a .cmd shim is
  // Windows-only), regardless of which platform this function happens to run
  // on (its own unit test runs on every CI platform); path.win32 keeps the
  // backslash parsing correct even when process.platform is not win32.
  return path.win32.join(path.win32.dirname(shimPath), match[1]);
}

/**
 * Resolves a PATH command to a directly-executable target so it can be
 * spawned with shell:false. On non-Windows platforms the command is already
 * directly executable via PATH lookup with no shell required, so this is a
 * no-op there.
 */
export function resolveExecutable(
  command: string,
  platform: NodeJS.Platform = process.platform,
): ResolvedExecutable {
  if (platform !== 'win32') return { file: command };

  let located: string[];
  try {
    located = execFileSync('where', [command], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    located = [];
  }
  if (located.length === 0) {
    throw new Error(`'${command}' was not found on PATH`);
  }

  const exe = located.find((p) => /\.exe$/i.test(p));
  if (exe !== undefined) return { file: exe };

  const shim = located.find((p) => /\.cmd$/i.test(p) || /\.bat$/i.test(p));
  if (shim !== undefined && existsSync(shim)) {
    const unwrapped = unwrapCmdShim(shim, readFileSync(shim, 'utf8'));
    if (unwrapped !== undefined && existsSync(unwrapped)) return { file: unwrapped };
  }

  throw new Error(
    `could not resolve '${command}' to a directly-executable binary on Windows ` +
      `(found on PATH: ${located.join(', ')}). Refusing to invoke it through a shell, ` +
      'since shell:true does not safely escape a multi-word argument.',
  );
}

/**
 * Spawns command safely: resolves to a directly-executable target and always
 * passes shell:false, so args (including multi-word elements) arrive at the
 * child exactly as given, on every platform.
 */
export function spawnSafely(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio = {},
): ChildProcess {
  const { file } = resolveExecutable(command);
  return spawn(file, args, { ...options, shell: false });
}
