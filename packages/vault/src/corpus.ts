import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodexFile, DistillProfile } from '@redutok/shared';
import {
  AuditWriter,
  NoopLlmPass,
  loadProfiles,
  openStore,
  readCodex,
  type LlmPass,
  type Store,
} from '@redutok/sidecar';

/**
 * A mounted corpus: the .dcp state that redutok init plus codex refresh
 * already produce (store, audit trail, codex), opened in-process. There is
 * no fail-open path here: a corpus that cannot be mounted is an explicit
 * error, never a silent raw fallback.
 */

export interface Corpus {
  name: string;
  root: string;
  dcpDir: string;
  auditPath: string;
  store: Store;
  audit: AuditWriter;
  profiles: Map<string, DistillProfile>;
  codex: CodexFile | undefined;
  llm: LlmPass;
}

export interface MountOptions {
  name?: string;
  /** LlmPass seam for dossier synthesis; defaults to the rule fallback. */
  llm?: LlmPass;
  env?: NodeJS.ProcessEnv;
}

/**
 * Profiles come from the corpus's own .dcp/config.json (written by redutok
 * init), then REDUTOK_PROFILES, then the monorepo's shipped profiles/.
 */
function resolveProfilesDir(dcpDir: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const config = JSON.parse(readFileSync(path.join(dcpDir, 'config.json'), 'utf8')) as {
      profilesDir?: unknown;
    };
    if (typeof config.profilesDir === 'string' && existsSync(config.profilesDir)) {
      return config.profilesDir;
    }
  } catch {
    // No config.json: fall through to the environment and the in-repo default.
  }
  const fromEnv = env['REDUTOK_PROFILES'];
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return fromEnv;
  const inRepo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'profiles');
  return existsSync(inRepo) ? inRepo : undefined;
}

export function mountCorpus(rootDir: string, options: MountOptions = {}): Corpus {
  const root = path.resolve(rootDir);
  const dcpDir = path.join(root, '.dcp');
  if (!existsSync(dcpDir)) {
    throw new Error(
      `cannot mount ${root}: no .dcp state directory; run redutok init (and codex refresh) there first`,
    );
  }
  const profilesDir = resolveProfilesDir(dcpDir, options.env ?? process.env);
  if (profilesDir === undefined) {
    throw new Error(
      `cannot mount ${root}: no distill profiles found via .dcp/config.json, REDUTOK_PROFILES, or the shipped profiles/`,
    );
  }
  const auditPath = path.join(dcpDir, 'audit.jsonl');
  const { codex } = readCodex(root);
  return {
    name: options.name ?? path.basename(root),
    root,
    dcpDir,
    auditPath,
    store: openStore(path.join(dcpDir, 'state.db')),
    audit: new AuditWriter(auditPath),
    profiles: loadProfiles(profilesDir),
    codex,
    llm: options.llm ?? new NoopLlmPass(),
  };
}
