import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadEnergyFactors,
  loadGridIntensity,
  loadPrices,
  readAuditFile,
} from '@redutok/shared';
import { mountCorpus, type Corpus } from '../src/corpus.js';
import {
  PROTOCOL_VERSION,
  handleVaultRequest,
  newVaultSession,
  type VaultDeps,
} from '../src/server.js';
import { buildVaultReceipt } from '../src/tools.js';
import { AWS_KEY_LITERAL, URL_BUILDER_SOURCE, makeCorpusDir, type TempCorpus } from './helpers.js';

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

let temp: TempCorpus;
let corpus: Corpus;
let deps: VaultDeps;

beforeAll(() => {
  temp = makeCorpusDir();
  corpus = mountCorpus(temp.root);
  deps = { corpora: new Map([[corpus.name, corpus]]), session: newVaultSession('server-test') };
});

afterAll(() => {
  corpus.store.close();
  temp.cleanup();
});

async function call(name: string, args: Record<string, unknown>, authorized = true): Promise<ToolResult> {
  const res = await handleVaultRequest(
    { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name, arguments: args } },
    deps,
    { authorized },
  );
  return res?.result as ToolResult;
}

const textOf = (r: ToolResult): string => r.content[0]?.text ?? '';

const parseNumber = (text: string, pattern: RegExp): number => {
  const match = pattern.exec(text);
  expect(match, `expected ${String(pattern)} in:\n${text}`).not.toBeNull();
  return Number((match?.[1] ?? '').replace(/,/g, ''));
};

describe('handshake and auth gate', () => {
  it('answers initialize without authorization', async () => {
    const res = await handleVaultRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
      deps,
      { authorized: false },
    );
    expect(res?.result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: 'redutok-vault' },
      capabilities: { tools: {} },
    });
  });

  it('refuses every other method without authorization', async () => {
    for (const method of ['tools/list', 'tools/call']) {
      const res = await handleVaultRequest({ jsonrpc: '2.0', id: 2, method }, deps, { authorized: false });
      expect(res?.error?.message).toMatch(/unauthorized/i);
      expect(res?.result).toBeUndefined();
    }
  });

  it('lists the three vault tools when authorized', async () => {
    const res = await handleVaultRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, deps, {
      authorized: true,
    });
    const tools = (res?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toEqual(['vault_ask', 'vault_zoom', 'vault_receipt']);
  });
});

describe('vault_ask', () => {
  let askText = '';

  it('produces a dossier with file:line evidence, zoom handles, and an accounting block', async () => {
    askText = textOf(
      await call('vault_ask', {
        question:
          'How does combineSegments assemble the final address from the base and the relative segment?',
      }),
    );
    expect(askText).toContain('url-builder.ts:');
    expect(askText).toMatch(/vault_zoom\("a[0-9a-f]{6}"/);
    expect(askText).toContain(`[vault accounting: ask ${deps.session.id}#ask1]`);
    expect(askText).toMatch(/reduction\s+[\d.]+x raw-versus-served/);
  });

  it('accounts raw and served bytes that reconcile with the audit trail', () => {
    const events = readAuditFile(corpus.auditPath).events.filter(
      (e) => e.sessionId === `${deps.session.id}#ask1`,
    );
    const rawBytes = events.reduce((n, e) => n + (e.bytesIn ?? 0), 0);
    expect(rawBytes).toBeGreaterThan(0);
    expect(parseNumber(askText, /raw touched\s+([\d,]+) bytes/)).toBe(rawBytes);
    const servedBytes = parseNumber(askText, /served\s+([\d,]+) bytes/);
    expect(servedBytes).toBeGreaterThan(0);
    expect(servedBytes).toBeLessThan(rawBytes);
  });

  it('writes a vault.ask audit event under the vault session id', () => {
    const events = readAuditFile(corpus.auditPath).events;
    expect(
      events.some((e) => e.module === 'vault.ask' && e.sessionId === deps.session.id),
    ).toBe(true);
  });

  it('fails explicitly without a question and on an unknown corpus', async () => {
    const missing = await call('vault_ask', {});
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/vault_ask failed/);
    const unknown = await call('vault_ask', { question: 'anything at all here', corpus: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/unknown corpus/);
  });
});

describe('vault_zoom', () => {
  it('recovers a stored artifact byte-equal to the source file', async () => {
    const askText = textOf(
      await call('vault_ask', {
        question: 'Where does encodeQuery sort and encode the query params before appending?',
      }),
    );
    const handles = [...askText.matchAll(/vault_zoom\("(a[0-9a-f]{6})"/g)].map((m) => m[1] ?? '');
    expect(handles.length).toBeGreaterThan(0);
    const texts: string[] = [];
    for (const handle of handles) texts.push(textOf(await call('vault_zoom', { handle })));
    expect(texts.some((t) => t === URL_BUILDER_SOURCE)).toBe(true);
  });

  it('accepts id as an alias for handle', async () => {
    const askText = textOf(
      await call('vault_ask', { question: 'What does segmentIsAbsolute treat as an absolute segment?' }),
    );
    const handle = /vault_zoom\("(a[0-9a-f]{6})"/.exec(askText)?.[1] ?? '';
    expect(handle).not.toBe('');
    const viaId = textOf(await call('vault_zoom', { id: handle }));
    const viaHandle = textOf(await call('vault_zoom', { handle }));
    expect(viaId).toBe(viaHandle);
  });

  it('writes a vault.zoom audit event under the vault session id', () => {
    const events = readAuditFile(corpus.auditPath).events;
    expect(
      events.some((e) => e.module === 'vault.zoom' && e.sessionId === deps.session.id),
    ).toBe(true);
  });

  it('fails with an explicit error for an unknown handle', async () => {
    const res = await call('vault_zoom', { handle: 'a000000' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/vault_zoom failed/);
    expect(textOf(res)).toMatch(/no artifact/);
  });
});

describe('redaction guardrail', () => {
  it('never serves a planted credential, stored or zoomed', async () => {
    const askText = textOf(
      await call('vault_ask', {
        question: 'Where does uploadTarget point uploads and which uploadKey credentials ride along?',
      }),
    );
    expect(askText).not.toContain(AWS_KEY_LITERAL);
    const handles = [...askText.matchAll(/vault_zoom\("(a[0-9a-f]{6})"/g)].map((m) => m[1] ?? '');
    expect(handles.length).toBeGreaterThan(0);
    let sawMarker = false;
    for (const handle of handles) {
      const zoomed = textOf(await call('vault_zoom', { handle }));
      expect(zoomed).not.toContain(AWS_KEY_LITERAL);
      if (zoomed.includes('[REDACTED:aws-access-key]')) sawMarker = true;
    }
    expect(sawMarker).toBe(true);
  });
});

describe('vault_receipt', () => {
  it('reconciles the session rollup with the audit trail', () => {
    const receipt = buildVaultReceipt(corpus, deps.session.id);
    const events = readAuditFile(corpus.auditPath).events.filter(
      (e) => typeof e.sessionId === 'string' && e.sessionId.startsWith(deps.session.id),
    );
    const measured = events.filter((e) => e.bytesIn !== undefined && e.bytesOut !== undefined);
    const avoided = measured.reduce(
      (n, e) =>
        n + Math.max(0, Math.round((e.bytesIn ?? 0) / 4) - Math.round((e.bytesOut ?? 0) / 4)),
      0,
    );
    expect(receipt.scope).toBe('session');
    expect(receipt.auditEvents).toBe(events.length);
    expect(receipt.avoidedTokens).toBe(avoided);
    expect(receipt.avoidedTokens).toBeGreaterThan(0);
    expect(receipt.topDistillations.length).toBeGreaterThan(0);
    expect(receipt.topDistillations[0]?.ref).toMatch(/^a[0-9a-f]{6}$/);
  });

  it('prices cost avoided from prices.yaml and bands energy per METHODOLOGY.md', () => {
    const receipt = buildVaultReceipt(corpus, deps.session.id);
    const row = loadPrices().models.find((m) => m.id === receipt.referenceModel);
    expect(row).toBeDefined();
    expect(receipt.costAvoidedUsd).toBeCloseTo(
      (receipt.avoidedTokens / 1e6) * (row?.inputPerMTokUsd ?? 0),
      10,
    );
    const cls = loadEnergyFactors().classes.find((c) => c.models.includes(receipt.referenceModel));
    expect(cls).toBeDefined();
    expect(receipt.wh.base).toBeCloseTo((receipt.avoidedTokens / 1e6) * (cls?.whPerMTok.base ?? 0), 10);
    expect(receipt.wh.low).toBeLessThanOrEqual(receipt.wh.base);
    expect(receipt.wh.base).toBeLessThanOrEqual(receipt.wh.high);
    const grid = loadGridIntensity();
    const gridRow = grid.regions.find((r) => r.region === grid.defaultRegion);
    expect(receipt.region).toBe(grid.defaultRegion);
    expect(receipt.gCo2e.base).toBeCloseTo((receipt.wh.base / 1000) * (gridRow?.gCo2ePerKwh ?? 0), 10);
  });

  it('corpus-lifetime scope covers at least the session scope', () => {
    const session = buildVaultReceipt(corpus, deps.session.id);
    const lifetime = buildVaultReceipt(corpus);
    expect(lifetime.scope).toBe('corpus');
    expect(lifetime.auditEvents).toBeGreaterThanOrEqual(session.auditEvents);
    expect(lifetime.avoidedTokens).toBeGreaterThanOrEqual(session.avoidedTokens);
  });

  it('renders the receipt as a tool result and audits the call', async () => {
    const text = textOf(await call('vault_receipt', { scope: 'session' }));
    expect(text).toContain('Redutok vault receipt');
    expect(text).toContain('cost avoided');
    expect(text).toMatch(/Wh \(band /);
    expect(text).toMatch(/gCO2e \(band /);
    const events = readAuditFile(corpus.auditPath).events;
    expect(
      events.some((e) => e.module === 'vault.receipt' && e.sessionId === deps.session.id),
    ).toBe(true);
  });
});

describe('explicit failures, never silence', () => {
  it('rejects an unknown tool with a protocol error', async () => {
    const res = await handleVaultRequest(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'vault_nope', arguments: {} } },
      deps,
      { authorized: true },
    );
    expect(res?.error?.code).toBe(-32602);
  });

  it('refuses to mount a directory without .dcp state', () => {
    expect(() => mountCorpus(path.join(temp.root, 'src'))).toThrow(/\.dcp/);
  });
});
