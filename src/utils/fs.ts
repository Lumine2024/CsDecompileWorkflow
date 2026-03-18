import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { constants } from 'node:fs';

export async function readFileText(p: string): Promise<string> {
  return readFile(p, 'utf-8');
}

export async function writeFileText(p: string, content: string): Promise<void> {
  await ensureDir(dirname(p));
  await writeFile(p, content, 'utf-8');
}

export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(p: string): Promise<T> {
  const raw = await readFileText(p);
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(p: string, data: unknown): Promise<void> {
  await writeFileText(p, JSON.stringify(data, null, 2));
}
