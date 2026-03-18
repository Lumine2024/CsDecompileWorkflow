import { join, relative, dirname } from 'node:path';
import { resolve } from 'node:path';
import type {
  PipelineContext,
  FinalSummary,
  AIMetadata,
  UnresolvedIssue,
  TransformRecord,
  Logger,
} from '../../types/index.js';
import { writeJsonFile, writeFileText, ensureDir } from '../../utils/fs.js';
import { normalizePath } from '../../utils/paths.js';

export async function runPhaseF(context: PipelineContext, logger: Logger): Promise<void> {
  logger.phase('F-output', 'Writing output files and reports…');

  const { config, projectMeta, projectIndex, repairResult, cleanupResult, globalCluster } =
    context;

  await ensureDir(config.outputPath);
  await ensureDir(join(config.outputPath, 'reports'));

  // Write repaired .cs files
  if (!config.dryRun && projectMeta) {
    await writeRepairedFiles(context, logger);
  } else if (config.dryRun) {
    logger.info('Dry run mode - skipping file writes');
  }

  // Collect all transforms
  const allTransforms: TransformRecord[] = [];
  if (repairResult) {
    for (const fr of Object.values(repairResult.fileResults)) {
      allTransforms.push(...fr.transforms);
    }
  }
  if (cleanupResult) {
    for (const fr of Object.values(cleanupResult.fileResults)) {
      allTransforms.push(...fr.transforms);
    }
  }

  // Collect unresolved issues
  const unresolvedIssues: UnresolvedIssue[] = [];
  if (cleanupResult) {
    for (const junk of cleanupResult.suspectedJunk) {
      unresolvedIssues.push({
        filePath: junk.filePath,
        line: junk.lineStart,
        kind: junk.kind,
        description: junk.reason,
        snippet: junk.snippet,
      });
    }
  }

  // Build final summary
  const summary: FinalSummary = {
    inputPath: config.inputPath,
    outputPath: config.outputPath,
    runAt: new Date().toISOString(),
    phases: Object.entries(config.phases)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name),
    totalFiles: projectMeta?.totalFiles ?? 0,
    totalTransforms: allTransforms.length,
    appliedTransforms: allTransforms.filter((t) => t.applied).length,
    suspectedJunkCount: cleanupResult?.suspectedJunk.length ?? 0,
    unresolvedIssueCount: unresolvedIssues.length,
    obfuscatedSymbolCount: globalCluster?.totalObfuscatedSymbols ?? 0,
    clusterCount: Object.keys(globalCluster?.clusters ?? {}).length,
    dryRun: config.dryRun,
  };

  await writeJsonFile(join(config.outputPath, 'reports', 'summary.json'), summary);
  logger.info('Written summary.json');

  await writeJsonFile(
    join(config.outputPath, 'reports', 'transform-log.json'),
    allTransforms,
  );
  logger.info('Written transform-log.json');

  await writeJsonFile(
    join(config.outputPath, 'reports', 'unresolved-issues.json'),
    unresolvedIssues,
  );
  logger.info('Written unresolved-issues.json');

  if (cleanupResult) {
    await writeJsonFile(
      join(config.outputPath, 'reports', 'suspected-unsafe.json'),
      cleanupResult.suspectedJunk,
    );
    logger.info('Written suspected-unsafe.json');
  }

  if (projectIndex) {
    await writeJsonFile(
      join(config.outputPath, 'reports', 'reflection-hotspots.json'),
      projectIndex.reflectionHotspots,
    );
    logger.info('Written reflection-hotspots.json');
  }

  if (globalCluster) {
    await writeJsonFile(
      join(config.outputPath, 'reports', 'name-clusters.json'),
      globalCluster.clusters,
    );
    logger.info('Written name-clusters.json');
  }

  // Build and write AI metadata
  if (projectMeta && globalCluster) {
    const aiMetadata: AIMetadata = {
      projectMeta,
      globalCluster,
      reflectionHotspots: projectIndex?.reflectionHotspots ?? [],
      stringAnnotations: projectIndex?.stringLiterals ?? [],
      unresolvedIssues,
      suspectedJunk: cleanupResult?.suspectedJunk ?? [],
      transformLog: allTransforms,
      generatedAt: new Date().toISOString(),
    };

    await writeJsonFile(
      join(config.outputPath, 'reports', 'ai-metadata.json'),
      aiMetadata,
    );
    logger.info('Written ai-metadata.json');
  }

  logger.success(
    `Phase F complete: reports written to ${join(config.outputPath, 'reports')}`,
  );
}

async function writeRepairedFiles(context: PipelineContext, logger: Logger): Promise<void> {
  const { config, projectMeta, cleanupResult, repairResult } = context;
  if (!projectMeta) return;

  const inputRoot = resolve(config.inputPath);
  const outputRoot = resolve(config.outputPath);
  let writtenCount = 0;

  for (const filePath of projectMeta.allCsFiles) {
    // Get the most up-to-date content (prefer cleanup > repair > original)
    let content: string | undefined;
    if (cleanupResult?.fileResults[filePath]) {
      content = cleanupResult.fileResults[filePath]!.repairedContent;
    } else if (repairResult?.fileResults[filePath]) {
      content = repairResult.fileResults[filePath]!.repairedContent;
    }
    if (!content) continue;

    // Mirror directory structure
    const relPath = relative(inputRoot, filePath);
    const outPath = normalizePath(join(outputRoot, relPath));

    try {
      await ensureDir(dirname(outPath));
      await writeFileText(outPath, content);
      writtenCount++;
    } catch (err) {
      logger.warn(`Failed to write ${outPath}: ${String(err)}`);
    }
  }

  logger.info(`Wrote ${writtenCount} repaired .cs file(s) to ${outputRoot}`);
}
