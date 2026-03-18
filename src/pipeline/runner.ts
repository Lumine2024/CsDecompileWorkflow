import type {
  DeobfuscatorConfig,
  PipelineContext,
  ProjectMeta,
  ProjectIndex,
  RepairPhaseResult,
  CleanupPhaseResult,
  GlobalCluster,
  Logger,
} from '../types/index.js';
import { fileExists, readJsonFile, ensureDir } from '../utils/fs.js';
import { join } from 'node:path';
import { runPhaseA } from '../phases/A-discovery/index.js';
import { runPhaseB } from '../phases/B-indexing/index.js';
import { runPhaseC } from '../phases/C-repair/index.js';
import { runPhaseD } from '../phases/D-cleanup/index.js';
import { runPhaseE } from '../phases/E-clustering/index.js';
import { runPhaseF } from '../phases/F-output/index.js';

const PHASE_CACHE: Record<string, string> = {
  A: 'phase-A-discovery.json',
  B: 'phase-B-indexing.json',
  C: 'phase-C-repair.json',
  D: 'phase-D-cleanup.json',
  E: 'phase-E-clustering.json',
};

function shouldRunPhase(phases: string[], phaseId: string): boolean {
  return phases.includes('ALL') || phases.includes('all') || phases.includes(phaseId);
}

async function tryLoadCache<T>(cacheDir: string, fileName: string): Promise<T | undefined> {
  const cachePath = join(cacheDir, fileName);
  if (await fileExists(cachePath)) {
    try {
      return await readJsonFile<T>(cachePath);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function runPipeline(
  config: DeobfuscatorConfig,
  phases: string[],
  logger: Logger,
): Promise<PipelineContext> {
  await ensureDir(config.cacheDir);

  const context: PipelineContext = { config };
  const normalizedPhases = phases.map((p) => p.toUpperCase());

  // Phase A - Discovery
  if (shouldRunPhase(normalizedPhases, 'A')) {
    context.projectMeta = await runPhaseA(config, logger);
  } else {
    const cached = await tryLoadCache<ProjectMeta>(config.cacheDir, PHASE_CACHE['A']!);
    if (cached) {
      logger.info('Using cached Phase A results');
      context.projectMeta = cached;
    }
  }

  if (!context.projectMeta) {
    logger.error('No project metadata available. Run Phase A first.');
    return context;
  }

  // Phase B - Indexing
  if (shouldRunPhase(normalizedPhases, 'B')) {
    context.projectIndex = await runPhaseB(context.projectMeta, config, logger);
  } else {
    const cached = await tryLoadCache<ProjectIndex>(config.cacheDir, PHASE_CACHE['B']!);
    if (cached) {
      logger.info('Using cached Phase B results');
      context.projectIndex = cached;
    }
  }

  // Phase C - Repair
  if (shouldRunPhase(normalizedPhases, 'C')) {
    if (!context.projectIndex) {
      logger.warn('Phase C requires Phase B index. Running Phase B first…');
      context.projectIndex = await runPhaseB(context.projectMeta, config, logger);
    }
    context.repairResult = await runPhaseC(
      context.projectMeta,
      context.projectIndex,
      config,
      logger,
    );
  } else {
    const cached = await tryLoadCache<RepairPhaseResult>(config.cacheDir, PHASE_CACHE['C']!);
    if (cached) {
      logger.info('Using cached Phase C results');
      context.repairResult = cached;
    }
  }

  // Phase D - Cleanup
  if (shouldRunPhase(normalizedPhases, 'D')) {
    if (!context.repairResult) {
      logger.warn('Phase D requires Phase C results. Running Phase C first…');
      if (!context.projectIndex) {
        context.projectIndex = await runPhaseB(context.projectMeta, config, logger);
      }
      context.repairResult = await runPhaseC(
        context.projectMeta,
        context.projectIndex,
        config,
        logger,
      );
    }
    context.cleanupResult = await runPhaseD(
      context.projectMeta,
      context.repairResult,
      config,
      logger,
    );
  } else {
    const cached = await tryLoadCache<CleanupPhaseResult>(config.cacheDir, PHASE_CACHE['D']!);
    if (cached) {
      logger.info('Using cached Phase D results');
      context.cleanupResult = cached;
    }
  }

  // Phase E - Clustering
  if (shouldRunPhase(normalizedPhases, 'E')) {
    if (!context.projectIndex) {
      logger.warn('Phase E requires Phase B index. Running Phase B first…');
      context.projectIndex = await runPhaseB(context.projectMeta, config, logger);
    }
    context.globalCluster = await runPhaseE(context.projectIndex, config, logger);
  } else {
    const cached = await tryLoadCache<GlobalCluster>(config.cacheDir, PHASE_CACHE['E']!);
    if (cached) {
      logger.info('Using cached Phase E results');
      context.globalCluster = cached;
    }
  }

  // Phase F - Output
  if (shouldRunPhase(normalizedPhases, 'F')) {
    await runPhaseF(context, logger);
  }

  return context;
}
