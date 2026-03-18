// ---- Config ----
export interface DeobfuscatorConfig {
  inputPath: string;
  outputPath: string;
  cacheDir: string;
  dryRun: boolean;
  aggressiveMode: boolean;
  phases: {
    discovery: boolean;
    indexing: boolean;
    repair: boolean;
    cleanup: boolean;
    clustering: boolean;
    output: boolean;
  };
  repair: {
    fixSetterValueParam: boolean;
    fixCompilerConventionMembers: boolean;
    fixDelegatePatterns: boolean;
    fixConstructors: boolean;
  };
  cleanup: {
    removeDoWhileFalse: boolean;
    removeConstantConditions: boolean;
    removeMeaninglessSwitches: boolean;
    removeDeadCode: boolean;
    removeUnreferencedLocals: boolean;
    removeEmptyBlocks: boolean;
    removeGotoLabelGarbage: boolean;
    removeNoiseTryCatch: boolean;
    minConfidence: number;
  };
  clustering: {
    minOccurrences: number;
    enableRoleTagging: boolean;
  };
}

// ---- Phase A: Discovery ----
export interface SlnProject {
  name: string;
  path: string;
  guid: string;
  typeGuid: string;
}

export interface CsprojInfo {
  path: string;
  assemblyName: string;
  rootNamespace: string;
  targetFramework: string;
  sourceFiles: string[];
  references: string[];
}

export interface ProjectMeta {
  slnPath: string;
  slnProjects: SlnProject[];
  csprojInfos: CsprojInfo[];
  allCsFiles: string[];
  totalFiles: number;
  totalSizeBytes: number;
  scannedAt: string;
}

// ---- Phase B: Indexing ----
export type SymbolKind =
  | 'namespace'
  | 'class'
  | 'struct'
  | 'interface'
  | 'enum'
  | 'delegate'
  | 'method'
  | 'property'
  | 'event'
  | 'field'
  | 'constructor'
  | 'static_constructor'
  | 'indexer'
  | 'operator'
  | 'local'
  | 'parameter'
  | 'unknown';

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  containingType?: string;
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  returnType?: string;
  parameterTypes?: string[];
  modifiers?: string[];
  attributes?: string[];
  isObfuscated: boolean;
}

export interface ReflectionHotspot {
  filePath: string;
  line: number;
  kind:
    | 'Type.GetType'
    | 'GetMethod'
    | 'GetField'
    | 'GetProperty'
    | 'InvokeMember'
    | 'Activator.CreateInstance'
    | 'MethodInfo.Invoke'
    | 'Delegate.CreateDelegate'
    | 'other';
  rawText: string;
  associatedStringLiteral?: string;
}

export interface StringLiteralAnnotation {
  filePath: string;
  line: number;
  value: string;
  category:
    | 'url'
    | 'filePath'
    | 'jsonKey'
    | 'configKey'
    | 'exceptionMessage'
    | 'uiText'
    | 'resourceName'
    | 'tableName'
    | 'unknown';
  nearbySymbol?: string;
}

export interface DelegateHotspot {
  filePath: string;
  line: number;
  kind:
    | 'Invoke'
    | 'BeginInvoke'
    | 'EndInvoke'
    | 'event_add'
    | 'event_remove'
    | 'delegate_declaration'
    | 'anonymous_method'
    | 'lambda';
  rawText: string;
}

export interface FileIndex {
  filePath: string;
  sizeBytes: number;
  lineCount: number;
  namespaces: string[];
  types: SymbolInfo[];
  methods: SymbolInfo[];
  properties: SymbolInfo[];
  events: SymbolInfo[];
  fields: SymbolInfo[];
  usingDirectives: string[];
  attributes: string[];
  stringLiterals: StringLiteralAnnotation[];
  reflectionHotspots: ReflectionHotspot[];
  delegateHotspots: DelegateHotspot[];
  identifierFrequency: Record<string, number>;
  obfuscatedIdentifiers: string[];
  indexedAt: string;
}

export interface NameClusterEntry {
  name: string;
  occurrences: number;
  files: string[];
  kinds: SymbolKind[];
  returnTypes: string[];
  parameterTypeSets: string[][];
  coOccurringStringLiterals: string[];
  coOccurringReflectionKinds: string[];
}

export interface ProjectIndex {
  fileIndexes: Record<string, FileIndex>;
  globalIdentifierFrequency: Record<string, number>;
  obfuscatedNameClusters: Record<string, NameClusterEntry>;
  reflectionHotspots: ReflectionHotspot[];
  delegateHotspots: DelegateHotspot[];
  stringLiterals: StringLiteralAnnotation[];
  indexedAt: string;
}

// ---- Phase C: Repair ----
export type TransformSafetyLevel = 'safe' | 'likely_safe' | 'uncertain' | 'risky';
export type ConfidenceLevel = number;

export interface TransformRecord {
  id: string;
  phase: 'C-repair' | 'D-cleanup';
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  transformType: string;
  oldContent: string;
  newContent: string;
  confidence: ConfidenceLevel;
  safetyLevel: TransformSafetyLevel;
  reason: string;
  applied: boolean;
  rolledBack?: boolean;
}

export interface FileRepairResult {
  filePath: string;
  originalContent: string;
  repairedContent: string;
  transforms: TransformRecord[];
  diff?: string;
}

export interface RepairPhaseResult {
  fileResults: Record<string, FileRepairResult>;
  totalTransforms: number;
  appliedTransforms: number;
  skippedTransforms: number;
  repairedAt: string;
}

// ---- Phase D: Cleanup ----
export interface SuspectedJunk {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  kind: string;
  snippet: string;
  reason: string;
  confidence: ConfidenceLevel;
}

export interface CleanupPhaseResult {
  fileResults: Record<string, FileRepairResult>;
  suspectedJunk: SuspectedJunk[];
  totalTransforms: number;
  appliedTransforms: number;
  cleanedAt: string;
}

// ---- Phase E: Clustering ----
export type RoleTag =
  | 'probable_handler'
  | 'probable_wrapper'
  | 'probable_dispatcher'
  | 'probable_factory'
  | 'probable_state_holder'
  | 'probable_transformer'
  | 'probable_utility'
  | 'probable_callback'
  | 'unknown';

export interface ClusterNode {
  name: string;
  occurrences: number;
  files: string[];
  kinds: SymbolKind[];
  dominantKind: SymbolKind;
  signatures: string[];
  coOccurringStrings: string[];
  reflectionInvolvement: boolean;
  roleTag: RoleTag;
  roleSupportingEvidence: string[];
}

export interface SignatureBucket {
  signature: string;
  members: string[];
  count: number;
}

export interface WrapperChain {
  root: string;
  chain: string[];
  evidence: string;
}

export interface DispatcherRoot {
  name: string;
  file: string;
  line: number;
  targetCount: number;
  evidence: string;
}

export interface GlobalCluster {
  clusters: Record<string, ClusterNode>;
  signatureBuckets: SignatureBucket[];
  reflectionHotspots: ReflectionHotspot[];
  wrapperChains: WrapperChain[];
  dispatcherRoots: DispatcherRoot[];
  totalObfuscatedSymbols: number;
  clusteredAt: string;
}

// ---- Phase F: Output ----
export interface UnresolvedIssue {
  filePath: string;
  line?: number;
  kind: string;
  description: string;
  snippet?: string;
}

export interface FinalSummary {
  inputPath: string;
  outputPath: string;
  runAt: string;
  phases: string[];
  totalFiles: number;
  totalTransforms: number;
  appliedTransforms: number;
  suspectedJunkCount: number;
  unresolvedIssueCount: number;
  obfuscatedSymbolCount: number;
  clusterCount: number;
  dryRun: boolean;
}

export interface AIMetadata {
  projectMeta: ProjectMeta;
  globalCluster: GlobalCluster;
  reflectionHotspots: ReflectionHotspot[];
  stringAnnotations: StringLiteralAnnotation[];
  unresolvedIssues: UnresolvedIssue[];
  suspectedJunk: SuspectedJunk[];
  transformLog: TransformRecord[];
  generatedAt: string;
}

// ---- Pipeline ----
export interface PipelineContext {
  config: DeobfuscatorConfig;
  projectMeta?: ProjectMeta;
  projectIndex?: ProjectIndex;
  repairResult?: RepairPhaseResult;
  cleanupResult?: CleanupPhaseResult;
  globalCluster?: GlobalCluster;
}

// ---- Logger (exported type for cross-module use) ----
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
  success(msg: string): void;
  phase(name: string, msg: string): void;
}
