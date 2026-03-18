import { resolve, dirname, join, relative } from 'node:path';
import { stat } from 'node:fs/promises';
import fg from 'fast-glob';
import type { DeobfuscatorConfig, ProjectMeta, SlnProject, CsprojInfo, Logger } from '../../types/index.js';
import { readFileText, writeJsonFile, ensureDir, fileExists } from '../../utils/fs.js';
import { normalizePath } from '../../utils/paths.js';

export async function runPhaseA(
  config: DeobfuscatorConfig,
  logger: Logger,
): Promise<ProjectMeta> {
  logger.phase('A-discovery', 'Starting project discovery…');

  const inputPath = resolve(config.inputPath);
  await ensureDir(config.cacheDir);

  // Find .sln file
  const slnFiles = await fg('**/*.sln', { cwd: inputPath, absolute: true, deep: 3 });
  const slnPath = slnFiles.length > 0 ? normalizePath(slnFiles[0]!) : '';

  if (slnPath) {
    logger.info(`Found solution: ${slnPath}`);
  } else {
    logger.warn('No .sln file found - proceeding with directory scan only');
  }

  // Parse .sln
  const slnProjects: SlnProject[] = [];
  if (slnPath) {
    try {
      const slnContent = await readFileText(slnPath);
      slnProjects.push(...parseSlnProjects(slnContent));
      logger.info(`Found ${slnProjects.length} project(s) in solution`);
    } catch (err) {
      logger.warn(`Failed to parse .sln: ${String(err)}`);
    }
  }

  // Parse each .csproj
  const csprojInfos: CsprojInfo[] = [];
  const slnDir = slnPath ? dirname(slnPath) : inputPath;

  for (const proj of slnProjects) {
    const csprojPath = normalizePath(resolve(slnDir, proj.path));
    if (await fileExists(csprojPath)) {
      try {
        const info = await parseCsproj(csprojPath, inputPath);
        csprojInfos.push(info);
        logger.debug(`Parsed csproj: ${csprojPath}`);
      } catch (err) {
        logger.warn(`Failed to parse csproj ${csprojPath}: ${String(err)}`);
      }
    }
  }

  // Discover all .cs files
  logger.info('Scanning for .cs files…');
  const csFiles = await fg('**/*.cs', {
    cwd: inputPath,
    absolute: true,
    ignore: ['**/obj/**', '**/bin/**'],
  });
  const allCsFiles = csFiles.map(normalizePath);
  logger.info(`Discovered ${allCsFiles.length} .cs file(s)`);

  // Compute total size
  let totalSizeBytes = 0;
  for (const f of allCsFiles) {
    try {
      const s = await stat(f);
      totalSizeBytes += s.size;
    } catch {
      // ignore
    }
  }

  const projectMeta: ProjectMeta = {
    slnPath,
    slnProjects,
    csprojInfos,
    allCsFiles,
    totalFiles: allCsFiles.length,
    totalSizeBytes,
    scannedAt: new Date().toISOString(),
  };

  await writeJsonFile(join(config.cacheDir, 'phase-A-discovery.json'), projectMeta);
  logger.success(
    `Phase A complete: ${allCsFiles.length} files, ${(totalSizeBytes / 1024).toFixed(1)} KB`,
  );

  return projectMeta;
}

function parseSlnProjects(slnContent: string): SlnProject[] {
  const projects: SlnProject[] = [];
  const projectRegex =
    /Project\("(\{[^}]+\})"\)\s*=\s*"([^"]+)"\s*,\s*"([^"]+\.csproj)"\s*,\s*"(\{[^}]+\})"/gi;
  let match: RegExpExecArray | null;
  while ((match = projectRegex.exec(slnContent)) !== null) {
    projects.push({
      typeGuid: match[1]!,
      name: match[2]!,
      path: normalizePath(match[3]!),
      guid: match[4]!,
    });
  }
  return projects;
}

async function parseCsproj(csprojPath: string, inputRoot: string): Promise<CsprojInfo> {
  const content = await readFileText(csprojPath);

  const assemblyNameMatch = content.match(/<AssemblyName>([^<]+)<\/AssemblyName>/);
  const rootNsMatch = content.match(/<RootNamespace>([^<]+)<\/RootNamespace>/);
  const targetFwMatch = content.match(/<TargetFramework>([^<]+)<\/TargetFramework>/);

  const csprojDir = dirname(csprojPath);
  const baseName = csprojPath.split('/').pop()?.replace('.csproj', '') ?? 'Unknown';

  // Discover source files relative to the csproj directory
  const sourceFiles = await fg('**/*.cs', {
    cwd: csprojDir,
    absolute: true,
    ignore: ['**/obj/**', '**/bin/**'],
  });

  // Extract references
  const references: string[] = [];
  const refRegex = /<PackageReference\s+Include="([^"]+)"/g;
  let refMatch: RegExpExecArray | null;
  while ((refMatch = refRegex.exec(content)) !== null) {
    references.push(refMatch[1]!);
  }
  const projRefRegex = /<ProjectReference\s+Include="([^"]+)"/g;
  let projRefMatch: RegExpExecArray | null;
  while ((projRefMatch = projRefRegex.exec(content)) !== null) {
    references.push(normalizePath(relative(inputRoot, resolve(csprojDir, projRefMatch[1]!))));
  }

  return {
    path: csprojPath,
    assemblyName: assemblyNameMatch?.[1] ?? baseName,
    rootNamespace: rootNsMatch?.[1] ?? baseName,
    targetFramework: targetFwMatch?.[1] ?? 'unknown',
    sourceFiles: sourceFiles.map(normalizePath),
    references,
  };
}
