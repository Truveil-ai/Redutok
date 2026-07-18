import { readFileSync } from 'node:fs';
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
  cacheWritePerMTokUsd: z.number().nonnegative(),
  source: z.string().min(1),
});
export type PriceRow = z.infer<typeof PriceRowSchema>;

export const PricesFileSchema = z.object({
  version: z.number().int().positive(),
  currency: z.literal('USD'),
  models: z.array(PriceRowSchema).min(1),
});
export type PricesFile = z.infer<typeof PricesFileSchema>;

export const EnergyFactorRowSchema = z.object({
  modelClass: z.string().min(1),
  whPerMTokMin: z.number().nonnegative(),
  whPerMTokMax: z.number().nonnegative(),
  contextMultipliers: z
    .array(
      z.object({
        upToTokens: z.number().int().positive(),
        multiplier: z.number().positive(),
      }),
    )
    .default([]),
  source: z.string().min(1),
});
export type EnergyFactorRow = z.infer<typeof EnergyFactorRowSchema>;

export const EnergyFactorsFileSchema = z.object({
  version: z.number().int().positive(),
  factors: z.array(EnergyFactorRowSchema).min(1),
});
export type EnergyFactorsFile = z.infer<typeof EnergyFactorsFileSchema>;

export function loadYamlFile<S extends z.ZodTypeAny>(filePath: string, schema: S): z.infer<S> {
  const raw = readFileSync(filePath, 'utf8');
  return schema.parse(parseYaml(raw));
}

export function loadPrices(filePath: string): PricesFile {
  return loadYamlFile(filePath, PricesFileSchema);
}

export function loadEnergyFactors(filePath: string): EnergyFactorsFile {
  return loadYamlFile(filePath, EnergyFactorsFileSchema);
}
