import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type {
  DeobfuscatorConfig,
  ProjectMeta,
  RepairPhaseResult,
  CleanupPhaseResult,
  FileRepairResult,
  TransformRecord,
  SuspectedJunk,
  Logger,
} from '../../types/index.js';
import { writeJsonFile, ensureDir } from '../../utils/fs.js';

let cleanupCounter = 0;

function nextId(): string {
  cleanupCounter++;
  return `D-${String(cleanupCounter).padStart(3, '0')}`;
}

export async function runPhaseD(
  meta: ProjectMeta,
  repairResult: RepairPhaseResult,
  config: DeobfuscatorConfig,
  logger: Logger,
): Promise<CleanupPhaseResult> {
  logger.phase('D-cleanup', `Applying cleanup to ${meta.allCsFiles.length} file(s)…`);
  await ensureDir(config.cacheDir);

  cleanupCounter = 0;
  const fileResults: Record<string, FileRepairResult> = {};
  const allSuspectedJunk: SuspectedJunk[] = [];
  let totalTransforms = 0;
  let appliedTransforms = 0;

  for (const filePath of meta.allCsFiles) {
    const repaired = repairResult.fileResults[filePath];
    const inputContent = repaired ? repaired.repairedContent : '';
    if (!inputContent) continue;

    try {
      const { content, transforms, suspectedJunk } = cleanupFile(
        filePath,
        inputContent,
        config,
      );

      const diff =
        content !== inputContent
          ? createTwoFilesPatch(filePath, filePath, inputContent, content, 'pre-cleanup', 'cleaned')
          : undefined;

      fileResults[filePath] = {
        filePath,
        originalContent: inputContent,
        repairedContent: content,
        transforms,
        diff,
      };

      totalTransforms += transforms.length;
      appliedTransforms += transforms.filter((t) => t.applied).length;
      allSuspectedJunk.push(...suspectedJunk);
    } catch (err) {
      logger.warn(`Failed to clean ${filePath}: ${String(err)}`);
    }
  }

  const cleanupResult: CleanupPhaseResult = {
    fileResults,
    suspectedJunk: allSuspectedJunk,
    totalTransforms,
    appliedTransforms,
    cleanedAt: new Date().toISOString(),
  };

  await writeJsonFile(join(config.cacheDir, 'phase-D-cleanup.json'), cleanupResult);
  logger.success(
    `Phase D complete: ${appliedTransforms} transforms applied, ${allSuspectedJunk.length} suspected junk items`,
  );

  return cleanupResult;
}

interface CleanupResult {
  content: string;
  transforms: TransformRecord[];
  suspectedJunk: SuspectedJunk[];
}

function cleanupFile(
  filePath: string,
  content: string,
  config: DeobfuscatorConfig,
): CleanupResult {
  let current = content;
  const transforms: TransformRecord[] = [];
  const suspectedJunk: SuspectedJunk[] = [];
  const minConf = config.cleanup.minConfidence;

  if (config.cleanup.removeDoWhileFalse) {
    current = removeDoWhileFalse(filePath, current, transforms, suspectedJunk, minConf, config.dryRun);
  }
  if (config.cleanup.removeConstantConditions) {
    current = removeConstantConditions(filePath, current, transforms, suspectedJunk, minConf, config.dryRun);
  }
  if (config.cleanup.removeMeaninglessSwitches) {
    current = removeMeaninglessSwitches(filePath, current, transforms, suspectedJunk, minConf, config.dryRun);
  }
  if (config.cleanup.removeDeadCode) {
    current = removeDeadGotoLabels(filePath, current, transforms, suspectedJunk, minConf, config.dryRun);
  }
  if (config.cleanup.removeNoiseTryCatch) {
    current = removeEmptyCatch(filePath, current, transforms, suspectedJunk, minConf, config.dryRun);
  }
  if (config.cleanup.removeUnreferencedLocals) {
    current = removeUnreferencedLocals(filePath, current, transforms, suspectedJunk, minConf, config.dryRun);
  }

  return { content: current, transforms, suspectedJunk };
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function removeDoWhileFalse(
  filePath: string,
  content: string,
  transforms: TransformRecord[],
  suspectedJunk: SuspectedJunk[],
  minConf: number,
  dryRun: boolean,
): string {
  const confidence = 0.95;
  // Simple single-level do { ... } while(false); removal
  // Only when there's no break in the inner block
  const regex = /do\s*\{([\s\S]*?)\}\s*while\s*\(\s*false\s*\)\s*;/g;
  let result = content;
  let offset = 0;
  let m: RegExpExecArray | null;
  const copy = content;
  const regex2 = /do\s*\{([\s\S]*?)\}\s*while\s*\(\s*false\s*\)\s*;/g;

  while ((m = regex2.exec(copy)) !== null) {
    const inner = m[1] ?? '';
    const lineStart = lineOf(copy, m.index);
    const lineEnd = lineOf(copy, m.index + m[0].length);
    // Don't transform if there's a break (it changes semantics)
    if (/\bbreak\b/.test(inner)) {
      suspectedJunk.push({
        filePath,
        lineStart,
        lineEnd,
        kind: 'do_while_false_with_break',
        snippet: m[0].slice(0, 80),
        reason: 'do-while(false) with break - removing would change semantics',
        confidence: 0.5,
      });
      continue;
    }

    if (confidence >= minConf) {
      transforms.push({
        id: nextId(),
        phase: 'D-cleanup',
        filePath,
        lineStart,
        lineEnd,
        transformType: 'remove_do_while_false',
        oldContent: `do { ... } while(false);`,
        newContent: `{ ... } // unwrapped`,
        confidence,
        safetyLevel: 'safe',
        reason: 'do-while(false) is an obfuscator control-flow pattern; inner block is equivalent',
        applied: !dryRun,
      });
      if (!dryRun) {
        result = result.replace(m[0], inner.trim());
      }
    } else {
      suspectedJunk.push({
        filePath,
        lineStart,
        lineEnd,
        kind: 'do_while_false',
        snippet: m[0].slice(0, 80),
        reason: 'do-while(false) pattern - confidence below threshold',
        confidence,
      });
    }
  }

  return result;
}

function removeConstantConditions(
  filePath: string,
  content: string,
  transforms: TransformRecord[],
  suspectedJunk: SuspectedJunk[],
  minConf: number,
  dryRun: boolean,
): string {
  let result = content;

  // Remove: if (false) { ... }
  const ifFalseRegex = /if\s*\(\s*false\s*\)\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  let m: RegExpExecArray | null;
  while ((m = ifFalseRegex.exec(result)) !== null) {
    const confidence = 0.85;
    const lineStart = lineOf(result, m.index);
    if (confidence >= minConf) {
      transforms.push({
        id: nextId(),
        phase: 'D-cleanup',
        filePath,
        lineStart,
        transformType: 'remove_constant_false_if',
        oldContent: m[0].slice(0, 60),
        newContent: '',
        confidence,
        safetyLevel: 'likely_safe',
        reason: 'if(false) block never executes - dead code',
        applied: !dryRun,
      });
      if (!dryRun) {
        result = result.replace(m[0], '');
      }
    } else {
      suspectedJunk.push({
        filePath,
        lineStart,
        lineEnd: lineOf(result, m.index + m[0].length),
        kind: 'constant_false_if',
        snippet: m[0].slice(0, 80),
        reason: 'if(false) dead code block',
        confidence,
      });
    }
  }

  // Remove: while (false) { ... }
  const whileFalseRegex = /while\s*\(\s*false\s*\)\s*\{[^{}]*\}/g;
  while ((m = whileFalseRegex.exec(result)) !== null) {
    const confidence = 0.7;
    const lineStart = lineOf(result, m.index);
    if (confidence >= minConf) {
      transforms.push({
        id: nextId(),
        phase: 'D-cleanup',
        filePath,
        lineStart,
        transformType: 'remove_constant_false_while',
        oldContent: m[0].slice(0, 60),
        newContent: '',
        confidence,
        safetyLevel: 'uncertain',
        reason: 'while(false) block never executes',
        applied: !dryRun,
      });
      if (!dryRun) {
        result = result.replace(m[0], '');
      }
    } else {
      suspectedJunk.push({
        filePath,
        lineStart,
        lineEnd: lineOf(result, m.index + m[0].length),
        kind: 'while_false',
        snippet: m[0].slice(0, 80),
        reason: 'while(false) dead code',
        confidence,
      });
    }
  }

  // Unwrap: if (true) { ... }
  const ifTrueRegex = /if\s*\(\s*true\s*\)\s*\{([\s\S]*?)\}/g;
  while ((m = ifTrueRegex.exec(result)) !== null) {
    const inner = m[1] ?? '';
    const confidence = 0.85;
    const lineStart = lineOf(result, m.index);
    if (confidence >= minConf) {
      transforms.push({
        id: nextId(),
        phase: 'D-cleanup',
        filePath,
        lineStart,
        transformType: 'remove_constant_true_if',
        oldContent: `if(true) { ... }`,
        newContent: inner.trim(),
        confidence,
        safetyLevel: 'likely_safe',
        reason: 'if(true) always executes - unwrap inner block',
        applied: !dryRun,
      });
      if (!dryRun) {
        result = result.replace(m[0], inner.trim());
      }
    } else {
      suspectedJunk.push({
        filePath,
        lineStart,
        lineEnd: lineOf(result, m.index + m[0].length),
        kind: 'constant_true_if',
        snippet: m[0].slice(0, 80),
        reason: 'if(true) wrapping - can be unwrapped',
        confidence,
      });
    }
  }

  return result;
}

function removeMeaninglessSwitches(
  filePath: string,
  content: string,
  transforms: TransformRecord[],
  suspectedJunk: SuspectedJunk[],
  minConf: number,
  dryRun: boolean,
): string {
  // Detect switch where all cases are just goto/break
  const switchRegex = /switch\s*\([^)]+\)\s*\{([\s\S]*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = switchRegex.exec(content)) !== null) {
    const inner = m[1] ?? '';
    const lineStart = lineOf(content, m.index);
    const lineEnd = lineOf(content, m.index + m[0].length);

    // Count meaningful statements (not just goto/break/case/default/empty)
    const statements = inner.split(';').map((s) => s.trim()).filter(Boolean);
    const meaningfulStatements = statements.filter(
      (s) => !/^(goto|break|case|default)/.test(s) && s !== '',
    );

    if (meaningfulStatements.length === 0 && statements.length > 0) {
      const confidence = 0.75;
      suspectedJunk.push({
        filePath,
        lineStart,
        lineEnd,
        kind: 'meaningless_switch',
        snippet: m[0].slice(0, 80),
        reason: 'Switch with only goto/break cases - likely obfuscator control flow',
        confidence,
      });
    }
  }

  return content; // Conservative - only add to suspected, don't remove
}

function removeDeadGotoLabels(
  filePath: string,
  content: string,
  transforms: TransformRecord[],
  suspectedJunk: SuspectedJunk[],
  minConf: number,
  dryRun: boolean,
): string {
  let result = content;

  // Find all labels (word followed by colon, not in case/default context)
  const labelRegex = /^\s*([A-Za-z_]\w*)\s*:\s*$/gm;
  const gotoRegex = /\bgoto\s+([A-Za-z_]\w*)\s*;/g;

  const definedLabels = new Set<string>();
  const usedLabels = new Set<string>();

  let m: RegExpExecArray | null;
  while ((m = labelRegex.exec(content)) !== null) {
    definedLabels.add(m[1]!);
  }
  while ((m = gotoRegex.exec(content)) !== null) {
    usedLabels.add(m[1]!);
  }

  // Remove labels that are never goto'd
  for (const label of definedLabels) {
    if (!usedLabels.has(label)) {
      const confidence = 0.8;
      const deadLabelRegex = new RegExp(`^(\\s*)${label}\\s*:\\s*$`, 'm');
      const labelMatch = deadLabelRegex.exec(result);
      if (labelMatch) {
        const lineStart = lineOf(result, labelMatch.index);
        if (confidence >= minConf) {
          transforms.push({
            id: nextId(),
            phase: 'D-cleanup',
            filePath,
            lineStart,
            transformType: 'remove_dead_goto_label',
            oldContent: `${label}:`,
            newContent: '',
            confidence,
            safetyLevel: 'likely_safe',
            reason: `Label '${label}' is defined but never used in a goto statement`,
            applied: !dryRun,
          });
          if (!dryRun) {
            result = result.replace(deadLabelRegex, '');
          }
        } else {
          suspectedJunk.push({
            filePath,
            lineStart,
            lineEnd: lineStart,
            kind: 'dead_goto_label',
            snippet: `${label}:`,
            reason: 'Label defined but never goto\'d',
            confidence,
          });
        }
      }
    }
  }

  return result;
}

function removeEmptyCatch(
  filePath: string,
  content: string,
  transforms: TransformRecord[],
  suspectedJunk: SuspectedJunk[],
  minConf: number,
  dryRun: boolean,
): string {
  let result = content;
  const confidence = 0.65;

  const emptyCatchRegex = /catch\s*\([^)]*\)\s*\{\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = emptyCatchRegex.exec(result)) !== null) {
    const lineStart = lineOf(result, m.index);
    if (confidence >= minConf) {
      transforms.push({
        id: nextId(),
        phase: 'D-cleanup',
        filePath,
        lineStart,
        transformType: 'remove_empty_catch',
        oldContent: m[0].slice(0, 60),
        newContent: '',
        confidence,
        safetyLevel: 'uncertain',
        reason: 'Empty catch block swallows exceptions silently',
        applied: !dryRun,
      });
      if (!dryRun) {
        result = result.replace(m[0], '');
      }
    } else {
      suspectedJunk.push({
        filePath,
        lineStart,
        lineEnd: lineStart,
        kind: 'empty_catch',
        snippet: m[0].slice(0, 80),
        reason: 'Empty catch block - potential noise from obfuscation',
        confidence,
      });
    }
  }

  return result;
}

function removeUnreferencedLocals(
  filePath: string,
  content: string,
  transforms: TransformRecord[],
  suspectedJunk: SuspectedJunk[],
  minConf: number,
  dryRun: boolean,
): string {
  let result = content;
  const confidence = 0.8;

  // Find local variable declarations
  const localDeclRegex =
    /^\s*(var|int|string|bool|float|double|long|object|byte|short|uint|ulong|ushort|sbyte|char|decimal)\s+(\w+)\s*=[^;]+;/gm;
  let m: RegExpExecArray | null;

  while ((m = localDeclRegex.exec(result)) !== null) {
    const varName = m[2]!;
    // Skip common loop variables
    if (/^(i|j|k|n|m|x|y|z|idx|len|count|num|result|ret|tmp|temp)$/.test(varName)) continue;

    // Check if the variable is used after its declaration
    const afterDecl = result.slice(m.index + m[0].length);
    const useRegex = new RegExp(`\\b${varName}\\b`);
    if (!useRegex.test(afterDecl)) {
      const lineStart = lineOf(result, m.index);
      if (confidence >= minConf) {
        transforms.push({
          id: nextId(),
          phase: 'D-cleanup',
          filePath,
          lineStart,
          transformType: 'remove_unreferenced_local',
          oldContent: m[0].trim().slice(0, 60),
          newContent: '',
          confidence,
          safetyLevel: 'likely_safe',
          reason: `Local variable '${varName}' is declared but never read`,
          applied: !dryRun,
        });
        if (!dryRun) {
          result = result.slice(0, m.index) + result.slice(m.index + m[0].length);
        }
      } else {
        suspectedJunk.push({
          filePath,
          lineStart,
          lineEnd: lineStart,
          kind: 'unreferenced_local',
          snippet: m[0].trim().slice(0, 80),
          reason: `Local '${varName}' never read - possibly dead variable`,
          confidence,
        });
      }
    }
  }

  return result;
}
