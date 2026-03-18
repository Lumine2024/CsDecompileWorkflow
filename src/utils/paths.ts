import type { StringLiteralAnnotation } from '../types/index.js';

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function isObfuscatedName(name: string): boolean {
  if (!name || name.length === 0) return true;
  // Contains non-printable or non-ASCII chars (ILSpy sometimes exports these)
  if (/[^\x20-\x7E]/.test(name)) return true;
  // Very short names (1-2 chars) that aren't common operators/generics
  if (name.length <= 2 && !/^(i|j|k|n|s|t|x|y|e|c|m|p|q|r|b|a|T|K|V)$/.test(name)) return true;
  // All caps hex-like pattern: e.g. ABCDE, A1B2C3
  if (/^[A-F0-9]{4,}$/.test(name)) return true;
  // Patterns like _0x123abc or similar
  if (/^_0x[0-9a-fA-F]+/.test(name)) return true;
  // ILSpy compiler-generated patterns like <>c__DisplayClass, <Module>
  if (/^[<>]/.test(name)) return true;
  return false;
}

export function categorizeStringLiteral(s: string): StringLiteralAnnotation['category'] {
  if (/^https?:\/\/|^ftp:\/\/|^\/\//i.test(s)) return 'url';
  if (/[/\\][a-zA-Z]|\.dll$|\.exe$|\.config$|\.xml$|\.json$/i.test(s)) return 'filePath';
  if (/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/.test(s) && s.length < 60) return 'configKey';
  if (s.includes('Exception') || s.includes('error') || s.includes('Error'))
    return 'exceptionMessage';
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s.length < 40) return 'jsonKey';
  if (/[A-Z][a-z]/.test(s) && s.includes(' ')) return 'uiText';
  return 'unknown';
}
