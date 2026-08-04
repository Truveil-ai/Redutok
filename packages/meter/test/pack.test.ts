import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function run(cmd: string, args: string[], cwd: string) {
  // Joined command string: args arrays with shell true are deprecated (DEP0190).
  return spawnSync([cmd, ...args].join(' '), { cwd, encoding: 'utf8', shell: true, timeout: 300_000 });
}

/** Runs a settings-verbatim hook command line with a Claude Code stdin payload. */
function runHook(command: string, cwd: string, payload: unknown) {
  return spawnSync(command, {
    cwd,
    encoding: 'utf8',
    shell: true,
    timeout: 300_000,
    input: JSON.stringify(payload),
  });
}

/** Two roots name the same repo, tolerating symlinked temp dirs and win32 case. */
function sameRoot(a: string, b: string): boolean {
  const canon = (p: string): string => {
    const real = realpathSync(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return canon(a) === canon(b);
}

const q = (p: string) => JSON.stringify(p.replace(/\\/g, '/'));

/**
 * Registry semantics, deliberately.
 *
 * The previous version of this test packed all five workspace packages and
 * wired the four private ones into the consumer via
 * `overrides: { "@redutok/shared": "file:..." }`. That kept the test green
 * while `npm i redutok` was broken for every real user: the four @redutok/*
 * packages are private and unpublished, so a consumer resolving them from the
 * registry gets E404. The overrides hid precisely the failure this test
 * exists to catch.
 *
 * So: pack ONLY redutok, install it with no overrides and no file: links, and
 * drive the CLI as a user would. If the published surface ever again needs a
 * package that is not on the public registry, this test fails.
 */
describe('packed tarball, registry semantics', () => {
  it('installs standalone, runs init and doctor, and drives one governed command end to end', async () => {
    const stage = mkdtempSync(path.join(os.tmpdir(), 'redutok-pack-'));
    const meterDir = path.join(repoRoot, 'packages', 'meter');

    const packed = run('pnpm', ['pack', '--pack-destination', q(stage)], meterDir);
    expect(packed.status, `pack redutok: ${packed.stderr}`).toBe(0);

    const tarballs = readdirSync(stage).filter((f) => f.endsWith('.tgz'));
    expect(tarballs, 'redutok packs alone').toHaveLength(1);
    const tarball = path.join(stage, tarballs[0] as string);

    // A bare consumer: no overrides, no resolutions, no workspace context.
    const app = mkdtempSync(path.join(os.tmpdir(), 'redutok-app-'));
    writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({ name: 'pack-consumer', private: true, version: '0.0.0' }, null, 2),
    );

    const install = run('npm', ['install', q(tarball), '--no-audit', '--no-fund', '--loglevel=error'], app);
    expect(install.status, `npm install: ${install.stderr}`).toBe(0);

    // Nothing from the private scope may reach a consumer's tree.
    const published = JSON.parse(
      readFileSync(path.join(app, 'node_modules', 'redutok', 'package.json'), 'utf8'),
    );
    const scoped = Object.keys(published.dependencies ?? {}).filter((d) => d.startsWith('@redutok/'));
    expect(scoped, 'published package.json must not depend on the private scope').toEqual([]);
    expect(existsSync(path.join(app, 'node_modules', '@redutok'))).toBe(false);

    const help = run('npx', ['--no-install', 'redutok', '--help'], app);
    expect(help.status, `npx redutok --help: ${help.stderr}`).toBe(0);
    expect(help.stdout).toContain('Usage: redutok');

    // init via npx, into the project that installed the package. npx resolves
    // the local node_modules/.bin first, which is the sequence the README
    // documents: install, then init.
    //
    // The separate-target shape this replaced (install in one dir, init
    // another) is exactly the broken setup: the launchers resolve the package
    // from the initialized project's own directory, so initializing a project
    // that has not installed redutok produces launchers that cannot resolve.
    const project = app;
    const init = run('npx', ['--no-install', 'redutok', 'init', '.'], project);
    expect(init.status, `redutok init: ${init.stderr}`).toBe(0);

    for (const rel of [
      '.dcp/config.json',
      '.claude/redutok/hook.mjs',
      '.claude/redutok/mcp.mjs',
      '.claude/redutok/pipe.mjs',
      '.claude/agents/scout.md',
      '.mcp.json',
      'CLAUDE.md',
    ]) {
      expect(existsSync(path.join(project, rel)), `init should write ${rel}`).toBe(true);
    }

    // A daemon without profiles starts cleanly and then answers 503 to every
    // distill request. init is what points it at them, so the path it wrote
    // has to exist and hold profiles.
    const dcpConfig = JSON.parse(readFileSync(path.join(project, '.dcp', 'config.json'), 'utf8'));
    expect(dcpConfig.profilesDir, 'init must resolve a profiles directory').toBeTypeOf('string');
    expect(existsSync(dcpConfig.profilesDir), `profiles dir ${dcpConfig.profilesDir} must exist`).toBe(true);
    expect(readdirSync(dcpConfig.profilesDir).filter((f) => f.endsWith('.yaml')).length).toBeGreaterThan(0);

    // The generated launchers resolve their entry point at runtime, through
    // the repo -> redutok chain. Executing hook.mjs would prove nothing (it is
    // fail-open and exits 0 even when resolution fails), so probe the same
    // chain directly: this is the assertion the fail-open path swallows.
    const probe = path.join(app, 'probe.mjs');
    writeFileSync(
      probe,
      `import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repoRequire = createRequire(pathToFileURL(path.join(process.cwd(), 'package.json')));
const meterPkg = repoRequire.resolve('redutok/package.json');
const req = createRequire(meterPkg);
for (const spec of ['redutok/hook-main', 'redutok/mcp-main', 'redutok/pipe']) {
  console.log(spec + ' -> ' + req.resolve(spec));
}
`,
    );
    const resolved = run('node', [q(probe)], app);
    expect(resolved.status, `launcher entry resolution: ${resolved.stderr}`).toBe(0);
    expect(resolved.stdout).toContain('redutok/hook-main ->');
    expect(resolved.stdout).toContain('redutok/mcp-main ->');

    // The check that would have caught the npx install being broken. init
    // completing and writing files says nothing about whether the result can
    // run: the first real-world install had doctor reporting FAIL on
    // mcp-launcher while hooks silently no-opped. doctor exits 1 on any fail.
    const doc = run('npx', ['--no-install', 'redutok', 'doctor'], project);
    expect(doc.stdout, `doctor reported a failure:\n${doc.stdout}`).not.toMatch(/^FAIL/m);
    expect(doc.status, `redutok doctor exit: ${doc.stderr}\n${doc.stdout}`).toBe(0);

    // One real governed operation, end to end, through the exact components
    // the tarball shipped: the settings-verbatim PreToolUse hook line, the
    // generated launchers, the packaged daemon, and the packaged profiles.
    // The 0.1.1 release proved that init completing and doctor passing say
    // nothing about whether the shipped seams agree with each other — the
    // field install ran with command distillation silently disabled. Release
    // verification now requires a command to travel the whole chain and leave
    // a distill audit event whose handle zooms back to the raw, byte-equal.
    const buildScript = path.join(project, 'scripts', 'build.mjs');
    mkdirSync(path.dirname(buildScript), { recursive: true });
    writeFileSync(
      buildScript,
      readFileSync(path.join(repoRoot, 'fixtures', 'repos', 'failing-tsc-build', 'scripts', 'build.mjs')),
    );
    const BUILD_CMD = 'node scripts/build.mjs';
    const SESSION = 'pack-e2e';

    const up = run('npx', ['--no-install', 'redutok', 'up'], project);
    expect(up.status, `redutok up: ${up.stderr}\n${up.stdout}`).toBe(0);
    expect(up.stdout).toContain('Sidecar started');
    try {
      const pidfile = JSON.parse(
        readFileSync(path.join(project, '.dcp', 'sidecar.pid.json'), 'utf8'),
      ) as { port: number };

      // The packaged daemon must identify as this project's, or every hook
      // correctly refuses to engage and the assertions below explain nothing.
      const health = (await (await fetch(`http://127.0.0.1:${pidfile.port}/health`)).json()) as {
        repoRoot?: string;
      };
      expect(health.repoRoot, 'packaged /health must report identity').toBeTypeOf('string');
      expect(sameRoot(health.repoRoot ?? '', project)).toBe(true);

      // The PreToolUse hook, invoked exactly as written into settings.
      const settings = JSON.parse(
        readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'),
      ) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
      const hookCommand = settings.hooks['PreToolUse']?.[0]?.hooks[0]?.command;
      expect(hookCommand).toBeTypeOf('string');

      const shellTool = process.platform === 'win32' ? 'PowerShell' : 'Bash';
      const pre = runHook(hookCommand as string, project, {
        session_id: SESSION,
        tool_name: shellTool,
        tool_input: { command: BUILD_CMD },
      });
      expect(pre.status, `hook run: ${pre.stderr}`).toBe(0);
      const hookOut = JSON.parse(pre.stdout.trim() || '{}') as {
        hookSpecificOutput?: { permissionDecision?: string; updatedInput?: { command?: string } };
      };
      expect(hookOut.hookSpecificOutput?.permissionDecision, `no rewrite from hook; stdout: ${pre.stdout}`).toBe('allow');
      const rewritten = hookOut.hookSpecificOutput?.updatedInput?.command ?? '';
      expect(rewritten).toContain('node .claude/redutok/pipe.mjs -c');

      // Reference vanilla run, for the exit code and the zoom byte-equality.
      const vanilla = spawnSync('node', ['scripts/build.mjs'], { cwd: project, encoding: 'utf8' });
      const rawText = (vanilla.stdout ?? '') + (vanilla.stderr ?? '');
      expect(vanilla.status).toBe(1);

      // Execute the rewritten command through the shell the matched tool
      // implies, exactly as Claude Code would run the updated input.
      const piped =
        process.platform === 'win32'
          ? spawnSync('powershell.exe', ['-NoProfile', '-Command', rewritten], {
              cwd: project,
              encoding: 'utf8',
              timeout: 300_000,
            })
          : spawnSync('bash', ['-c', rewritten], { cwd: project, encoding: 'utf8', timeout: 300_000 });
      const toolResult = piped.stdout ?? '';
      expect(piped.status, `pipe run: ${piped.stderr}`).toBe(1); // exit code preserved
      expect(toolResult, 'the tool result must be the distilled verdict, not the raw log').toContain('VERDICT: fail');
      expect(toolResult).toContain('dcp__zoom(');
      expect(toolResult.length).toBeLessThan(rawText.length);

      // The distill audit event, attributed to the hook-registered session.
      const audit = readFileSync(path.join(project, '.dcp', 'audit.jsonl'), 'utf8');
      expect(audit).toContain('"action":"rewrite"');
      expect(audit).toContain('"action":"distill"');
      expect(audit).toContain(`"sessionId":"${SESSION}"`);

      // Packaged-path zoom: the handle the tool result carries recovers the
      // raw artifact byte-equal, first request, no query.
      const artifactId = /\[dcp:artifact (a[0-9a-f]+),/.exec(toolResult)?.[1];
      expect(artifactId, `no artifact id in tool result:\n${toolResult}`).toBeDefined();
      const zoomRes = await fetch(`http://127.0.0.1:${pidfile.port}/zoom`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: artifactId, repoRoot: project }),
      });
      expect(zoomRes.status).toBe(200);
      const zoomed = (await zoomRes.json()) as { text: string };
      expect(zoomed.text).toBe(rawText);
    } finally {
      const down = run('npx', ['--no-install', 'redutok', 'down'], project);
      expect(down.status, `redutok down: ${down.stderr}`).toBe(0);
    }

    // And the setup that cannot run must be refused outright rather than
    // written and left broken.
    const bare = mkdtempSync(path.join(os.tmpdir(), 'redutok-bare-'));
    writeFileSync(
      path.join(bare, 'package.json'),
      JSON.stringify({ name: 'bare', private: true, version: '0.0.0' }, null, 2),
    );
    const refused = run('npx', ['--no-install', 'redutok', 'init', q(bare)], project);
    expect(refused.status, 'init into a project without redutok must fail').not.toBe(0);
    const refusal = `${refused.stdout}${refused.stderr}`;
    expect(refusal).toContain('npm install --save-dev redutok');
    // Refusing is an ordinary outcome, so it reads as an instruction rather
    // than a crash. A stack trace here buries the one line that fixes it.
    expect(refusal, `refusal surfaced as a crash:\n${refusal}`).not.toContain('at initRepo');
    expect(refusal).not.toContain('MODULE_NOT_FOUND');
    expect(existsSync(path.join(bare, '.claude')), 'refusal must write nothing').toBe(false);
    expect(existsSync(path.join(bare, '.dcp')), 'refusal must write nothing').toBe(false);
  }, 600_000);
});
