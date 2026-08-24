#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.swift', '.sh', '.py', '.rs', '.go', '.java', '.kt', '.c', '.cc', '.cpp', '.h', '.hpp', '.css', '.html', '.vue', '.svelte']);
const ignoredDirectories = new Set(['.git', '.firecrawl', 'node_modules', 'dist', 'target', 'Yomi.app']);
const han = /\p{Script=Han}/u;
const pictograph = /\p{Extended_Pictographic}/u;
const failures = [];

function filesUnder(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesUnder(path));
    else if (extensions.has(extname(entry.name))) output.push(path);
  }
  return output;
}

function commentFragments(line, inBlock) {
  const fragments = [];
  let cursor = 0;
  let block = inBlock;
  while (cursor < line.length) {
    if (block) {
      const end = line.indexOf('*/', cursor);
      fragments.push(line.slice(cursor, end < 0 ? line.length : end));
      if (end < 0) return { fragments, inBlock: true };
      block = false;
      cursor = end + 2;
      continue;
    }
    const blockStart = line.indexOf('/*', cursor);
    const lineStart = line.indexOf('//', cursor);
    const shellStart = line.slice(0, cursor).trim() === '' && line[cursor] === '#' && !line.startsWith('#!') ? cursor : -1;
    const starts = [blockStart, lineStart, shellStart].filter((value) => value >= 0);
    if (starts.length === 0) break;
    const start = Math.min(...starts);
    if (isInsideQuotedString(line, start)) {
      cursor = start + 2;
      continue;
    }
    if (start === lineStart) {
      fragments.push(line.slice(start + 2));
      break;
    }
    if (start === shellStart) {
      fragments.push(line.slice(start + 1));
      break;
    }
    block = true;
    cursor = start + 2;
  }
  return { fragments, inBlock: block };
}

function isInsideQuotedString(line, index) {
  let quote = null;
  let escaped = false;
  for (let position = 0; position < index; position += 1) {
    const character = line[position];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'" || character === '`') {
      quote = character;
    }
  }
  return quote !== null;
}

for (const path of filesUnder(root)) {
  let inBlock = false;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const result = commentFragments(line, inBlock);
    inBlock = result.inBlock;
    for (const fragment of result.fragments) {
      const allowsProtocolEmoji = fragment.includes('Protocol emoji mapping:');
      if (han.test(fragment) || (pictograph.test(fragment) && !allowsProtocolEmoji)) {
        failures.push(`${relative(root, path)}:${index + 1}: ${fragment.trim()}`);
      }
    }
  });
}

if (failures.length > 0) {
  console.error('Comments must use English text without emoji:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log('[comments] English-only, emoji-free comment check passed');
