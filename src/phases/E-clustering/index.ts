import { join } from 'node:path';
import type {
  DeobfuscatorConfig,
  ProjectIndex,
  GlobalCluster,
  ClusterNode,
  SignatureBucket,
  WrapperChain,
  DispatcherRoot,
  RoleTag,
  SymbolKind,
  Logger,
} from '../../types/index.js';
import { writeJsonFile, ensureDir } from '../../utils/fs.js';

export async function runPhaseE(
  index: ProjectIndex,
  config: DeobfuscatorConfig,
  logger: Logger,
): Promise<GlobalCluster> {
  logger.phase('E-clustering', 'Building global cluster analysis…');
  await ensureDir(config.cacheDir);

  const { minOccurrences, enableRoleTagging } = config.clustering;

  // Build clusters from obfuscated name clusters in index
  const clusters: Record<string, ClusterNode> = {};

  for (const [name, entry] of Object.entries(index.obfuscatedNameClusters)) {
    if (entry.occurrences < minOccurrences) continue;

    const dominantKind = getDominantKind(entry.kinds);
    const signatures = buildSignatures(entry);
    const reflectionInvolvement =
      entry.coOccurringReflectionKinds.length > 0;

    let roleTag: RoleTag = 'unknown';
    const roleSupportingEvidence: string[] = [];

    if (enableRoleTagging) {
      const role = inferRoleTag(entry, index, roleSupportingEvidence);
      roleTag = role;
    }

    clusters[name] = {
      name,
      occurrences: entry.occurrences,
      files: entry.files,
      kinds: entry.kinds,
      dominantKind,
      signatures,
      coOccurringStrings: entry.coOccurringStringLiterals.slice(0, 10),
      reflectionInvolvement,
      roleTag,
      roleSupportingEvidence,
    };
  }

  logger.info(`Built ${Object.keys(clusters).length} cluster nodes`);

  // Build signature buckets
  const signatureBuckets = buildSignatureBuckets(clusters);
  logger.info(`Built ${signatureBuckets.length} signature buckets`);

  // Build wrapper chains
  const wrapperChains = detectWrapperChains(index, clusters);
  logger.info(`Detected ${wrapperChains.length} wrapper chain(s)`);

  // Build dispatcher roots
  const dispatcherRoots = detectDispatcherRoots(index, clusters);
  logger.info(`Detected ${dispatcherRoots.length} dispatcher root(s)`);

  const globalCluster: GlobalCluster = {
    clusters,
    signatureBuckets,
    reflectionHotspots: index.reflectionHotspots,
    wrapperChains,
    dispatcherRoots,
    totalObfuscatedSymbols: Object.keys(clusters).length,
    clusteredAt: new Date().toISOString(),
  };

  await writeJsonFile(join(config.cacheDir, 'phase-E-clustering.json'), globalCluster);
  logger.success(
    `Phase E complete: ${Object.keys(clusters).length} clusters, ` +
      `${wrapperChains.length} wrapper chains, ${dispatcherRoots.length} dispatchers`,
  );

  return globalCluster;
}

function getDominantKind(kinds: SymbolKind[]): SymbolKind {
  if (kinds.length === 0) return 'unknown';
  const freq: Record<string, number> = {};
  for (const k of kinds) {
    freq[k] = (freq[k] ?? 0) + 1;
  }
  return (Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown') as SymbolKind;
}

function buildSignatures(entry: {
  returnTypes: string[];
  parameterTypeSets: string[][];
}): string[] {
  const sigs: string[] = [];
  const maxSigs = Math.min(entry.parameterTypeSets.length, entry.returnTypes.length, 5);
  for (let i = 0; i < maxSigs; i++) {
    const ret = entry.returnTypes[i] ?? 'void';
    const params = entry.parameterTypeSets[i]?.join(',') ?? '';
    sigs.push(`${ret}(${params})`);
  }
  // If only return types
  if (sigs.length === 0 && entry.returnTypes.length > 0) {
    for (const ret of entry.returnTypes.slice(0, 5)) {
      sigs.push(`${ret}(?)`);
    }
  }
  return sigs;
}

function inferRoleTag(
  entry: {
    kinds: SymbolKind[];
    coOccurringStringLiterals: string[];
    coOccurringReflectionKinds: string[];
    returnTypes: string[];
    parameterTypeSets: string[][];
    files: string[];
    occurrences: number;
  },
  index: ProjectIndex,
  evidence: string[],
): RoleTag {
  // probable_handler: event handler pattern
  for (const paramSet of entry.parameterTypeSets) {
    if (paramSet.some((p) => p.includes('EventArgs') || p.includes('EventHandler'))) {
      evidence.push('Has EventArgs parameter - likely event handler');
      return 'probable_handler';
    }
  }

  // probable_factory: returns new instances, Create/Get-like usage
  if (
    entry.returnTypes.some((r) => r !== 'void' && r !== 'bool' && r !== 'string') &&
    entry.coOccurringStringLiterals.some(
      (s) => s.toLowerCase().includes('create') || s.toLowerCase().includes('factory'),
    )
  ) {
    evidence.push('Returns non-trivial type and appears in factory context');
    return 'probable_factory';
  }

  // probable_wrapper: single method that likely passes through
  if (entry.occurrences <= 3 && entry.parameterTypeSets.length === 1) {
    evidence.push('Low occurrence count with single signature - likely wrapper');
    return 'probable_wrapper';
  }

  // probable_dispatcher: appears with many different call targets / reflection
  if (entry.coOccurringReflectionKinds.length > 2) {
    evidence.push(`Reflection involvement: ${entry.coOccurringReflectionKinds.join(', ')}`);
    return 'probable_dispatcher';
  }

  // probable_callback: used as delegate argument
  if (entry.kinds.includes('delegate') || entry.kinds.includes('method')) {
    const delegateHotspots = index.delegateHotspots.filter((dh) =>
      entry.files.includes(dh.filePath),
    );
    if (delegateHotspots.length > 0) {
      evidence.push('Appears near delegate hotspots - likely callback');
      return 'probable_callback';
    }
  }

  // probable_utility: called from many files
  if (entry.files.length > 5) {
    evidence.push(`Used in ${entry.files.length} files - likely utility`);
    return 'probable_utility';
  }

  // probable_state_holder: many fields, few methods
  if (entry.kinds.includes('field') && !entry.kinds.includes('method')) {
    evidence.push('Contains fields without methods - likely state holder');
    return 'probable_state_holder';
  }

  // probable_transformer: takes input and returns something
  if (
    entry.parameterTypeSets.some((ps) => ps.length === 1) &&
    entry.returnTypes.some((r) => r !== 'void')
  ) {
    evidence.push('Single-parameter with return value - likely transformer');
    return 'probable_transformer';
  }

  return 'unknown';
}

function buildSignatureBuckets(clusters: Record<string, ClusterNode>): SignatureBucket[] {
  const bucketMap: Record<string, string[]> = {};

  for (const node of Object.values(clusters)) {
    for (const sig of node.signatures) {
      if (!bucketMap[sig]) bucketMap[sig] = [];
      bucketMap[sig].push(node.name);
    }
  }

  return Object.entries(bucketMap)
    .filter(([, members]) => members.length > 1)
    .map(([signature, members]) => ({
      signature,
      members,
      count: members.length,
    }))
    .sort((a, b) => b.count - a.count);
}

function detectWrapperChains(
  index: ProjectIndex,
  clusters: Record<string, ClusterNode>,
): WrapperChain[] {
  const chains: WrapperChain[] = [];

  // Find clusters tagged as probable_wrapper and link them
  const wrappers = Object.values(clusters).filter((n) => n.roleTag === 'probable_wrapper');

  for (const wrapper of wrappers) {
    // Look for other wrappers in the same files
    const relatedWrappers = wrappers.filter(
      (w) => w.name !== wrapper.name && w.files.some((f) => wrapper.files.includes(f)),
    );
    if (relatedWrappers.length > 0) {
      const chain: WrapperChain = {
        root: wrapper.name,
        chain: [wrapper.name, ...relatedWrappers.slice(0, 4).map((w) => w.name)],
        evidence: `${wrapper.name} and ${relatedWrappers.length} related wrapper(s) in same file(s)`,
      };
      // Avoid duplicates
      if (!chains.some((c) => c.root === chain.root)) {
        chains.push(chain);
      }
    }
  }

  return chains.slice(0, 50); // Limit output
}

function detectDispatcherRoots(
  index: ProjectIndex,
  clusters: Record<string, ClusterNode>,
): DispatcherRoot[] {
  const roots: DispatcherRoot[] = [];

  for (const node of Object.values(clusters)) {
    if (node.roleTag === 'probable_dispatcher' || node.reflectionInvolvement) {
      const file = node.files[0] ?? '';
      const fileIndex = index.fileIndexes[file];
      let line = 0;
      if (fileIndex) {
        const method = fileIndex.methods.find((m) => m.name === node.name);
        line = method?.lineStart ?? 0;
      }

      roots.push({
        name: node.name,
        file,
        line,
        targetCount: node.coOccurringStrings.length + node.signatures.length,
        evidence: node.roleSupportingEvidence.join('; '),
      });
    }
  }

  return roots.slice(0, 50);
}
