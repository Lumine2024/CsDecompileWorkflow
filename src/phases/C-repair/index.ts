import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type {
  DeobfuscatorConfig,
  ProjectMeta,
  ProjectIndex,
  RepairPhaseResult,
  FileRepairResult,
  TransformRecord,
  Logger,
} from '../../types/index.js';
import { readFileText, writeJsonFile, ensureDir } from '../../utils/fs.js';

let transformCounter = 0;

function nextId(): string {
  transformCounter++;
  return `T-${String(transformCounter).padStart(3, '0')}`;
}

export async function runPhaseC(
  meta: ProjectMeta,
  index: ProjectIndex,
  config: DeobfuscatorConfig,
  logger: Logger,
): Promise<RepairPhaseResult> {
  logger.phase('C-repair', `Applying deterministic repairs to ${meta.allCsFiles.length} file(s)…`);
  await ensureDir(config.cacheDir);

  transformCounter = 0;
  const fileResults: Record<string, FileRepairResult> = {};
  let totalTransforms = 0;
  let appliedTransforms = 0;
  let skippedTransforms = 0;

  for (const filePath of meta.allCsFiles) {
    try {
      const originalContent = await readFileText(filePath);
      const result = repairFile(filePath, originalContent, config);
      fileResults[filePath] = result;
      totalTransforms += result.transforms.length;
      appliedTransforms += result.transforms.filter((t) => t.applied).length;
      skippedTransforms += result.transforms.filter((t) => !t.applied).length;
    } catch (err) {
      logger.warn(`Failed to repair ${filePath}: ${String(err)}`);
    }
  }

  const repairResult: RepairPhaseResult = {
    fileResults,
    totalTransforms,
    appliedTransforms,
    skippedTransforms,
    repairedAt: new Date().toISOString(),
  };

  await writeJsonFile(join(config.cacheDir, 'phase-C-repair.json'), repairResult);
  logger.success(
    `Phase C complete: ${appliedTransforms} applied, ${skippedTransforms} skipped transforms`,
  );

  return repairResult;
}

function repairFile(
  filePath: string,
  content: string,
  config: DeobfuscatorConfig,
): FileRepairResult {
  let current = content;
  const transforms: TransformRecord[] = [];

  if (config.repair.fixSetterValueParam) {
    current = fixSetterValueParam(filePath, current, transforms, config.dryRun);
  }
  if (config.repair.fixCompilerConventionMembers) {
    current = fixCompilerConventionMembers(filePath, current, transforms, config.dryRun);
  }
  if (config.repair.fixDelegatePatterns) {
    current = fixDelegatePatterns(filePath, current, transforms, config.dryRun);
  }
  if (config.repair.fixConstructors) {
    current = fixILSpyArtifacts(filePath, current, transforms, config.dryRun);
  }

  current = fixInvalidIdentifiers(filePath, current, transforms, config.dryRun);

  const diff =
    current !== content
      ? createTwoFilesPatch(filePath, filePath, content, current, 'original', 'repaired')
      : undefined;

  return {
    filePath,
    originalContent: content,
    repairedContent: current,
    transforms,
    diff,
  };
}

function fixSetterValueParam(
  filePath: string,
  content: string,
  transforms: TransformRecord[],
  dryRun: boolean,
): string {
  let result = content;

  // Fix `invalidString` used in setter contexts → replace with `value`
  const invalidStringRegex = /\binvalidString\b/g;
  let m: RegExpExecArray | null;
  while ((m = invalidStringRegex.exec(result)) !== null) {
    const lineStart = lineOf(result, m.index);
    transforms.push({
      id: nextId(),
      phase: 'C-repair',
      filePath,
      lineStart,
      transformType: 'fix_setter_value_param',
      oldContent: 'invalidString',
      newContent: 'value',
      confidence: 0.9,
      safetyLevel: 'likely_safe',
      reason: 'ILSpy exports setter implicit parameter as invalidString; should be value',
      applied: !dryRun,
    });
  }
  if (!dryRun) {
    result = result.replace(/\binvalidString\b/g, 'value');
  }

  // Fix setter blocks where an obfuscated all-caps name is assigned to a field
  // Pattern: `set { this.field = OBFNAME; }` → `set { this.field = value; }`
  const setterAssignRegex = /\bset\s*\{([^}]*?this\.\w+\s*=\s*)([A-Z]{3,}[0-9]*)\s*;/g;
  setterAssignRegex.lastIndex = 0;
  while ((m = setterAssignRegex.exec(result)) !== null) {
    const obfName = m[2]!;
    // Only replace if it looks obfuscated (all uppercase, no known names)
    if (/^[A-Z]{3,}[0-9]*$/.test(obfName) && obfName !== 'NULL' && obfName !== 'TRUE' && obfName !== 'FALSE') {
      const lineStart = lineOf(result, m.index);
      transforms.push({
        id: nextId(),
        phase: 'C-repair',
        filePath,
        lineStart,
        transformType: 'fix_setter_value_param',
        oldContent: obfName,
        newContent: 'value',
        confidence: 0.85,
        safetyLevel: 'likely_safe',
        reason: `Obfuscated setter parameter ${obfName} replaced with value`,
        applied: !dryRun,
      });
      if (!dryRun) {
        // Locate the obfuscated name precisely within the match, then replace by index
        const obfIdx = m.index + m[0]!.lastIndexOf(obfName);
        result = result.slice(0, obfIdx) + 'value' + result.slice(obfIdx + obfName.length);
        // Adjust lastIndex for the length change (obfName → 'value')
        setterAssignRegex.lastIndex = obfIdx + 'value'.length;
      }
    }
  }

  return result;
}

function fixCompilerConventionMembers(
  filePath: string,
  content: string,
  transforms: TransformRecord[],
  dryRun: boolean,
): string {
  let result = content;

  // Fix compiler-generated attribute noise: CompilerGeneratedAttribute
  const cgAttrRegex = /\[System\.Runtime\.CompilerServices\.CompilerGeneratedAttribute\]/g;
  if (cgAttrRegex.test(result)) {
    transforms.push({
      id: nextId(),
      phase: 'C-repair',
      filePath,
      lineStart: 1,
      transformType: 'fix_compiler_members',
      oldContent: '[System.Runtime.CompilerServices.CompilerGeneratedAttribute]',
      newContent: '[CompilerGenerated]',
      confidence: 0.95,
      safetyLevel: 'safe',
      reason: 'Normalize verbose CompilerGeneratedAttribute to short form',
      applied: !dryRun,
    });
    if (!dryRun) {
      result = result.replace(
        /\[System\.Runtime\.CompilerServices\.CompilerGeneratedAttribute\]/g,
        '[CompilerGenerated]',
      );
    }
  }

  return result;
}

function fixDelegatePatterns(
  filePath: string,
  content: string,
  transforms: TransformRecord[],
  dryRun: boolean,
): string {
  let result = content;

  // Fix null-conditional invoke: obj.Invoke( → obj?.Invoke(
  // Only where it's preceded by a null check context - conservative
  const nullInvokeRegex = /\b(\w+)\.Invoke\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = nullInvokeRegex.exec(result)) !== null) {
    const varName = m[1]!;
    // Check if the preceding context already has null check
    const before = result.slice(Math.max(0, m.index - 100), m.index);
    if (
      before.includes(`if (${varName} != null)`) ||
      before.includes(`if (${varName} is not null)`)
    ) {
      // Already guarded - suggest null-conditional form
      transforms.push({
        id: nextId(),
        phase: 'C-repair',
        filePath,
        lineStart: lineOf(result, m.index),
        transformType: 'fix_delegate_patterns',
        oldContent: `${varName}.Invoke(`,
        newContent: `${varName}?.Invoke(`,
        confidence: 0.7,
        safetyLevel: 'uncertain',
        reason: 'Delegate invoke can use null-conditional operator',
        applied: false, // Conservative - don't auto-apply
      });
    }
  }

  return result;
}

function fixILSpyArtifacts(
  filePath: string,
  content: string,
  transforms: TransformRecord[],
  dryRun: boolean,
): string {
  let result = content;

  // Fix <>c__DisplayClass compiler generated class name references in comments/strings
  // These are usually fine to leave but we annotate them
  if (/<>c__DisplayClass/.test(result)) {
    transforms.push({
      id: nextId(),
      phase: 'C-repair',
      filePath,
      lineStart: 1,
      transformType: 'fix_ilspy_artifacts',
      oldContent: '<>c__DisplayClass',
      newContent: '<>c__DisplayClass /* closure class */',
      confidence: 0.6,
      safetyLevel: 'uncertain',
      reason: 'Compiler-generated closure class - these are lambda/anonymous method captures',
      applied: false,
    });
  }

  // Fix `<Module>` class which ILSpy sometimes emits
  if (/class\s+<Module>/.test(result)) {
    transforms.push({
      id: nextId(),
      phase: 'C-repair',
      filePath,
      lineStart: 1,
      transformType: 'fix_ilspy_artifacts',
      oldContent: 'class <Module>',
      newContent: '// [ILSpy: <Module> global class - likely contains native methods]',
      confidence: 0.8,
      safetyLevel: 'likely_safe',
      reason: '<Module> is IL-level global class, not valid C#',
      applied: !dryRun,
    });
    if (!dryRun) {
      result = result.replace(/\bclass\s+<Module>/g, '// [ILSpy: <Module> global class]');
    }
  }

  return result;
}

function fixInvalidIdentifiers(
  filePath: string,
  content: string,
  transforms: TransformRecord[],
  dryRun: boolean,
): string {
  let result = content;

  // C# keywords used as identifiers without @ prefix
  const reservedKeywords = [
    'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char',
    'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate',
    'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false',
    'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit',
    'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace',
    'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private',
    'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed',
    'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch',
    'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked',
    'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while',
  ];

  // Detect parameter names that are C# reserved keywords (ILSpy sometimes does this)
  for (const kw of reservedKeywords) {
    // Pattern: (Type keyword) or (Type keyword, or , Type keyword)
    const paramRegex = new RegExp(`\\(([^)]*\\s)${kw}(\\s*[,)])`, 'g');
    let m: RegExpExecArray | null;
    while ((m = paramRegex.exec(result)) !== null) {
      transforms.push({
        id: nextId(),
        phase: 'C-repair',
        filePath,
        lineStart: lineOf(result, m.index),
        transformType: 'fix_invalid_identifiers',
        oldContent: ` ${kw}`,
        newContent: ` @${kw}`,
        confidence: 0.95,
        safetyLevel: 'safe',
        reason: `C# reserved keyword '${kw}' used as identifier; must be prefixed with @`,
        applied: !dryRun,
      });
      if (!dryRun) {
        const replacement = m[0]!.replace(new RegExp(`\\b${kw}\\b`), `@${kw}`);
        result = result.slice(0, m.index) + replacement + result.slice(m.index + m[0]!.length);
        // Adjust lastIndex for the extra '@' character that was inserted
        paramRegex.lastIndex = m.index + replacement.length;
      }
    }
  }

  return result;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}
