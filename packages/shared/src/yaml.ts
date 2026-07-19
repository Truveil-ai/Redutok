import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Schema-validated yaml loading for prices and energy factors.
 * Guardrail 2: every row must carry a source field. TODO-VERIFY is an
 * accepted literal for rows whose citation is not yet verified.
 */

export const PriceRowSchema = z.object({
  id: z.string().min(1),
  inputPerMTokUsd: z.number().nonnegative(),
  outputPerMTokUsd: z.number().nonnegative(),
  cacheReadPerMTokUsd: z.number().nonnegative(),
  /** 5-minute cache-write TTL rate (1.25x input on the official pricing page). */
  cacheWritePerMTokUsd: z.number().nonnegative(),
  /** 1-hour cache-write TTL rate (2x input on the official pricing page). */
  cacheWrite1hPerMTokUsd: z.number().nonnegative(),
  note: z.string().optional(),
  source: z.string().min(1),
});
export type PriceRow = z.infer<typeof PriceRowSchema>;

export const PricesFileSchema = z.object({
  version: z.number().int().positive(),
  currency: z.literal('USD'),
  models: z.array(PriceRowSchema).min(1),
});
export type PricesFile = z.infer<typeof PricesFileSchema>;

export const EnergyBandSchema = z
  .object({
    base: z.number().nonnegative(),
    low: z.number().nonnegative(),
    high: z.number().nonnegative(),
  })
  .refine((b) => b.low <= b.base && b.base <= b.high, {
    message: 'uncertainty band must satisfy low <= base <= high',
  });
export type EnergyBand = z.infer<typeof EnergyBandSchema>;

export const ContextMultiplierCurveSchema = z.object({
  confidence: z.string().min(1),
  source: z.string().min(1),
  curve: z
    .array(
      z.object({
        upToTokens: z.number().int().positive(),
        multiplier: z.number().positive(),
      }),
    )
    .min(1),
});
export type ContextMultiplierCurve = z.infer<typeof ContextMultiplierCurveSchema>;

export const EnergyFactorRowSchema = z.object({
  modelClass: z.string().min(1),
  models: z.array(z.string().min(1)).default([]),
  whPerMTok: EnergyBandSchema,
  /** True when the row is a class assumption rather than an anchored measurement. */
  assumption: z.boolean().optional(),
  contextMultipliers: ContextMultiplierCurveSchema,
  source: z.string().min(1),
  citation_hint: z.string().min(1),
  verified: z.string().optional(),
});
export type EnergyFactorRow = z.infer<typeof EnergyFactorRowSchema>;

export const EnergyFactorsFileSchema = z.object({
  version: z.number().int().positive(),
  classes: z.array(EnergyFactorRowSchema).min(1),
});
export type EnergyFactorsFile = z.infer<typeof EnergyFactorsFileSchema>;

export const GridIntensityRowSchema = z.object({
  region: z.string().min(1),
  gCo2ePerKwh: z.number().nonnegative(),
  source: z.string().min(1),
  citation_hint: z.string().min(1),
  note: z.string().optional(),
  verified: z.string().optional(),
});
export type GridIntensityRow = z.infer<typeof GridIntensityRowSchema>;

export const GridIntensityFileSchema = z
  .object({
    version: z.number().int().positive(),
    defaultRegion: z.string().min(1),
    regions: z.array(GridIntensityRowSchema).min(1),
  })
  .refine((f) => f.regions.some((r) => r.region === f.defaultRegion), {
    message: 'defaultRegion must have a matching row in regions',
  });
export type GridIntensityFile = z.infer<typeof GridIntensityFileSchema>;

export function loadYamlFile<S extends z.ZodTypeAny>(filePath: string, schema: S): z.infer<S> {
  const raw = readFileSync(filePath, 'utf8');
  return schema.parse(parseYaml(raw));
}

/** Absolute path of the prices.yaml shipped with this package. */
export function defaultPricesPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prices.yaml');
}

export function loadPrices(filePath: string = defaultPricesPath()): PricesFile {
  return loadYamlFile(filePath, PricesFileSchema);
}

/** Absolute path of the energy_factors.yaml shipped with this package. */
export function defaultEnergyFactorsPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'energy_factors.yaml');
}

/** Absolute path of the grid_intensity.yaml shipped with this package. */
export function defaultGridIntensityPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'grid_intensity.yaml');
}

export function loadEnergyFactors(filePath: string = defaultEnergyFactorsPath()): EnergyFactorsFile {
  return loadYamlFile(filePath, EnergyFactorsFileSchema);
}

export function loadGridIntensity(filePath: string = defaultGridIntensityPath()): GridIntensityFile {
  return loadYamlFile(filePath, GridIntensityFileSchema);
}
