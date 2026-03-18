import { join } from 'node:path';
import type {
  DeobfuscatorConfig,
  ProjectMeta,
  ProjectIndex,
  FileIndex,
  SymbolInfo,
  SymbolKind,
  ReflectionHotspot,
  StringLiteralAnnotation,
  DelegateHotspot,
  NameClusterEntry,
  Logger,
} from '../../types/index.js';
import { readFileText, writeJsonFile, ensureDir } from '../../utils/fs.js';
import { isObfuscatedName, categorizeStringLiteral } from '../../utils/paths.js';

export async function runPhaseB(
  meta: ProjectMeta,
  config: DeobfuscatorConfig,
  logger: Logger,
): Promise<ProjectIndex> {
  logger.phase('B-indexing', `Indexing ${meta.allCsFiles.length} file(s)…`);
  await ensureDir(config.cacheDir);

  const fileIndexes: Record<string, FileIndex> = {};
  let processed = 0;

  for (const filePath of meta.allCsFiles) {
    try {
      const content = await readFileText(filePath);
      const fileIndex = indexFile(filePath, content);
      fileIndexes[filePath] = fileIndex;
      processed++;
      if (processed % 50 === 0) {
        logger.debug(`Indexed ${processed}/${meta.allCsFiles.length} files`);
      }
    } catch (err) {
      logger.warn(`Failed to index ${filePath}: ${String(err)}`);
    }
  }

  logger.info(`Indexed ${processed} file(s). Building global structures…`);

  // Build global identifier frequency
  const globalIdentifierFrequency: Record<string, number> = {};
  for (const fi of Object.values(fileIndexes)) {
    for (const [id, count] of Object.entries(fi.identifierFrequency)) {
      globalIdentifierFrequency[id] = (globalIdentifierFrequency[id] ?? 0) + count;
    }
  }

  // Build obfuscated name clusters
  const obfuscatedNameClusters: Record<string, NameClusterEntry> = {};
  for (const fi of Object.values(fileIndexes)) {
    for (const obfId of fi.obfuscatedIdentifiers) {
      if (!obfuscatedNameClusters[obfId]) {
        obfuscatedNameClusters[obfId] = {
          name: obfId,
          occurrences: 0,
          files: [],
          kinds: [],
          returnTypes: [],
          parameterTypeSets: [],
          coOccurringStringLiterals: [],
          coOccurringReflectionKinds: [],
        };
      }
      const cluster = obfuscatedNameClusters[obfId]!;
      cluster.occurrences += fi.identifierFrequency[obfId] ?? 1;
      if (!cluster.files.includes(fi.filePath)) {
        cluster.files.push(fi.filePath);
      }

      // Add kinds from symbols
      const allSymbols = [...fi.types, ...fi.methods, ...fi.properties, ...fi.fields];
      for (const sym of allSymbols) {
        if (sym.name === obfId) {
          if (!cluster.kinds.includes(sym.kind)) cluster.kinds.push(sym.kind);
          if (sym.returnType && !cluster.returnTypes.includes(sym.returnType)) {
            cluster.returnTypes.push(sym.returnType);
          }
          if (sym.parameterTypes && sym.parameterTypes.length > 0) {
            cluster.parameterTypeSets.push(sym.parameterTypes);
          }
        }
      }

      // Co-occurring strings
      for (const sl of fi.stringLiterals) {
        if (!cluster.coOccurringStringLiterals.includes(sl.value)) {
          cluster.coOccurringStringLiterals.push(sl.value);
        }
      }
      // Co-occurring reflection kinds
      for (const rh of fi.reflectionHotspots) {
        if (!cluster.coOccurringReflectionKinds.includes(rh.kind)) {
          cluster.coOccurringReflectionKinds.push(rh.kind);
        }
      }
    }
  }

  // Aggregate hotspots and literals
  const reflectionHotspots: ReflectionHotspot[] = [];
  const delegateHotspots: DelegateHotspot[] = [];
  const stringLiterals: StringLiteralAnnotation[] = [];

  for (const fi of Object.values(fileIndexes)) {
    reflectionHotspots.push(...fi.reflectionHotspots);
    delegateHotspots.push(...fi.delegateHotspots);
    stringLiterals.push(...fi.stringLiterals);
  }

  const projectIndex: ProjectIndex = {
    fileIndexes,
    globalIdentifierFrequency,
    obfuscatedNameClusters,
    reflectionHotspots,
    delegateHotspots,
    stringLiterals,
    indexedAt: new Date().toISOString(),
  };

  await writeJsonFile(join(config.cacheDir, 'phase-B-indexing.json'), projectIndex);
  logger.success(
    `Phase B complete: ${Object.keys(obfuscatedNameClusters).length} obfuscated clusters, ` +
      `${reflectionHotspots.length} reflection hotspots`,
  );

  return projectIndex;
}

export function indexFile(filePath: string, content: string): FileIndex {
  const lines = content.split('\n');
  const sizeBytes = Buffer.byteLength(content, 'utf-8');
  const lineCount = lines.length;
  const now = new Date().toISOString();

  const namespaces = extractNamespaces(content);
  const usingDirectives = extractUsingDirectives(content);
  const types = extractTypes(filePath, content);
  const methods = extractMethods(filePath, content);
  const properties = extractProperties(filePath, content);
  const events = extractEvents(filePath, content);
  const fields = extractFields(filePath, content);
  const attributes = extractAttributes(content);
  const stringLiterals = extractStringLiterals(filePath, content);
  const reflectionHotspots = extractReflectionHotspots(filePath, content);
  const delegateHotspots = extractDelegateHotspots(filePath, content);
  const identifierFrequency = buildIdentifierFrequency(content);
  const obfuscatedIdentifiers = Object.keys(identifierFrequency).filter(isObfuscatedName);

  return {
    filePath,
    sizeBytes,
    lineCount,
    namespaces,
    types,
    methods,
    properties,
    events,
    fields,
    usingDirectives,
    attributes,
    stringLiterals,
    reflectionHotspots,
    delegateHotspots,
    identifierFrequency,
    obfuscatedIdentifiers,
    indexedAt: now,
  };
}

function lineNumberOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function extractNamespaces(content: string): string[] {
  const namespaces: string[] = [];
  const regex = /^\s*namespace\s+([\w.]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    if (!namespaces.includes(m[1]!)) namespaces.push(m[1]!);
  }
  return namespaces;
}

function extractUsingDirectives(content: string): string[] {
  const usings: string[] = [];
  const regex = /^\s*using\s+([\w.]+)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    if (!usings.includes(m[1]!)) usings.push(m[1]!);
  }
  return usings;
}

function extractAttributes(content: string): string[] {
  const attrs: string[] = [];
  const regex = /\[([A-Z][a-zA-Z]+(?:\([^)]*\))?)\]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    if (!attrs.includes(m[1]!)) attrs.push(m[1]!);
  }
  return attrs;
}

function extractTypes(filePath: string, content: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const regex =
    /^\s*(?:(?:public|internal|private|protected|static|abstract|sealed|partial)\s+)*?(class|struct|interface|enum|delegate)\s+(\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const kind = m[1] as SymbolKind;
    const name = m[2]!;
    symbols.push({
      name,
      kind,
      filePath,
      lineStart: lineNumberOf(content, m.index),
      isObfuscated: isObfuscatedName(name),
    });
  }
  return symbols;
}

function extractMethods(filePath: string, content: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const regex =
    /^\s*(public|private|protected|internal|static|virtual|override|abstract|sealed|extern|async)[\s\w<>[\],?]*\s+(\w+)\s*\(([^)]*)\)\s*(?:where\s+\w+\s*:[^{;]+)?\s*[{;]/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const name = m[2]!;
    // Filter out 'if', 'while', 'for', 'foreach', 'switch' etc.
    if (/^(if|while|for|foreach|switch|catch|using|lock|return|new)$/.test(name)) continue;
    const paramStr = m[3] ?? '';
    const paramTypes = paramStr
      .split(',')
      .map((p) => p.trim().split(/\s+/)[0] ?? '')
      .filter(Boolean);
    symbols.push({
      name,
      kind: 'method',
      filePath,
      lineStart: lineNumberOf(content, m.index),
      parameterTypes: paramTypes,
      isObfuscated: isObfuscatedName(name),
    });
  }
  return symbols;
}

function extractProperties(filePath: string, content: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const regex =
    /^\s*(public|private|protected|internal|static|virtual|override|abstract)\s+[\w<>[\],?]+\s+(\w+)\s*\{[\s\n]*(get|set)/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const name = m[2]!;
    symbols.push({
      name,
      kind: 'property',
      filePath,
      lineStart: lineNumberOf(content, m.index),
      isObfuscated: isObfuscatedName(name),
    });
  }
  return symbols;
}

function extractEvents(filePath: string, content: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const regex =
    /^\s*(?:public|private|protected|internal|static)?\s*event\s+([\w.<>]+)\s+(\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const name = m[2]!;
    symbols.push({
      name,
      kind: 'event',
      filePath,
      lineStart: lineNumberOf(content, m.index),
      returnType: m[1],
      isObfuscated: isObfuscatedName(name),
    });
  }
  return symbols;
}

function extractFields(filePath: string, content: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const regex =
    /^\s*(public|private|protected|internal|static|readonly|const)\s+([\w<>[\],?]+)\s+(\w+)\s*[;=]/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const name = m[3]!;
    // Skip common false positives
    if (/^(if|while|for|return|new|var)$/.test(name)) continue;
    symbols.push({
      name,
      kind: 'field',
      filePath,
      lineStart: lineNumberOf(content, m.index),
      returnType: m[2],
      modifiers: [m[1]!],
      isObfuscated: isObfuscatedName(name),
    });
  }
  return symbols;
}

function extractStringLiterals(filePath: string, content: string): StringLiteralAnnotation[] {
  const annotations: StringLiteralAnnotation[] = [];
  // Regular strings
  const regex = /"([^"\\]{2,}(?:\\.[^"\\]*)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const value = m[1]!;
    // Skip very long strings and obvious noise
    if (value.length > 200) continue;
    annotations.push({
      filePath,
      line: lineNumberOf(content, m.index),
      value,
      category: categorizeStringLiteral(value),
    });
  }
  // Verbatim strings @"..."
  const verbatimRegex = /@"([^"]*)"/g;
  while ((m = verbatimRegex.exec(content)) !== null) {
    const value = m[1]!;
    if (value.length > 200 || value.length < 2) continue;
    annotations.push({
      filePath,
      line: lineNumberOf(content, m.index),
      value,
      category: categorizeStringLiteral(value),
    });
  }
  return annotations;
}

function extractReflectionHotspots(filePath: string, content: string): ReflectionHotspot[] {
  const hotspots: ReflectionHotspot[] = [];

  const patterns: Array<{ regex: RegExp; kind: ReflectionHotspot['kind'] }> = [
    { regex: /Type\.GetType\s*\(/g, kind: 'Type.GetType' },
    { regex: /\.GetMethod\s*\(/g, kind: 'GetMethod' },
    { regex: /\.GetField\s*\(/g, kind: 'GetField' },
    { regex: /\.GetProperty\s*\(/g, kind: 'GetProperty' },
    { regex: /\.InvokeMember\s*\(/g, kind: 'InvokeMember' },
    { regex: /Activator\.CreateInstance\s*\(/g, kind: 'Activator.CreateInstance' },
    { regex: /\.Invoke\s*\(/g, kind: 'MethodInfo.Invoke' },
    { regex: /Delegate\.CreateDelegate\s*\(/g, kind: 'Delegate.CreateDelegate' },
  ];

  for (const { regex, kind } of patterns) {
    let m: RegExpExecArray | null;
    regex.lastIndex = 0;
    while ((m = regex.exec(content)) !== null) {
      const line = lineNumberOf(content, m.index);
      const rawText = content.slice(m.index, Math.min(m.index + 80, content.length)).split('\n')[0] ?? '';
      // Try to find associated string literal on the same line
      const lineContent = content.split('\n')[line - 1] ?? '';
      const strMatch = lineContent.match(/"([^"]{2,60})"/);
      hotspots.push({
        filePath,
        line,
        kind,
        rawText: rawText.trim(),
        associatedStringLiteral: strMatch?.[1],
      });
    }
  }

  return hotspots;
}

function extractDelegateHotspots(filePath: string, content: string): DelegateHotspot[] {
  const hotspots: DelegateHotspot[] = [];

  const patterns: Array<{ regex: RegExp; kind: DelegateHotspot['kind'] }> = [
    { regex: /\.Invoke\s*\(/g, kind: 'Invoke' },
    { regex: /\.BeginInvoke\s*\(/g, kind: 'BeginInvoke' },
    { regex: /\.EndInvoke\s*\(/g, kind: 'EndInvoke' },
    { regex: /\s*\+=\s*/g, kind: 'event_add' },
    { regex: /\s*-=\s*/g, kind: 'event_remove' },
    { regex: /\bdelegate\s+\w/g, kind: 'delegate_declaration' },
    { regex: /=>\s*[{(]/g, kind: 'lambda' },
  ];

  for (const { regex, kind } of patterns) {
    let m: RegExpExecArray | null;
    regex.lastIndex = 0;
    while ((m = regex.exec(content)) !== null) {
      const rawText = content.slice(m.index, Math.min(m.index + 60, content.length)).split('\n')[0] ?? '';
      hotspots.push({
        filePath,
        line: lineNumberOf(content, m.index),
        kind,
        rawText: rawText.trim(),
      });
    }
  }

  return hotspots;
}

function buildIdentifierFrequency(content: string): Record<string, number> {
  const freq: Record<string, number> = {};
  const regex = /\b([a-zA-Z_\u0080-\uffff][a-zA-Z0-9_\u0080-\uffff]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const id = m[1]!;
    freq[id] = (freq[id] ?? 0) + 1;
  }
  return freq;
}
