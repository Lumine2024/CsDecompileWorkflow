import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DeobfuscatorConfig } from '../types/index.js';

const DEFAULT_CONFIG: DeobfuscatorConfig = {
  inputPath: './input',
  outputPath: './output',
  cacheDir: './.cache',
  dryRun: false,
  aggressiveMode: true,
  phases: {
    discovery: true,
    indexing: true,
    repair: true,
    cleanup: true,
    clustering: true,
    output: true,
  },
  repair: {
    fixSetterValueParam: true,
    fixCompilerConventionMembers: true,
    fixDelegatePatterns: true,
    fixConstructors: true,
  },
  cleanup: {
    removeDoWhileFalse: true,
    removeConstantConditions: true,
    removeMeaninglessSwitches: true,
    removeDeadCode: true,
    removeUnreferencedLocals: true,
    removeEmptyBlocks: true,
    removeGotoLabelGarbage: true,
    removeNoiseTryCatch: true,
    minConfidence: 0.7,
  },
  clustering: {
    minOccurrences: 2,
    enableRoleTagging: true,
  },
};

export async function loadConfig(configPath?: string): Promise<DeobfuscatorConfig> {
  const targetPath = configPath
    ? resolve(configPath)
    : resolve(process.cwd(), 'deobfuscator.config.json');

  let partial: Partial<DeobfuscatorConfig> = {};

  try {
    const raw = await readFile(targetPath, 'utf-8');
    partial = JSON.parse(raw) as Partial<DeobfuscatorConfig>;
  } catch {
    // Config file not found or invalid - use defaults
  }

  return deepMerge(DEFAULT_CONFIG, partial);
}

function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const overrideVal = override[key];
    const baseVal = base[key];
    if (
      overrideVal !== null &&
      overrideVal !== undefined &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      typeof baseVal === 'object' &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal as object, overrideVal as object) as T[keyof T];
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal as T[keyof T];
    }
  }
  return result;
}
