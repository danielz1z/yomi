/**
 * Rewrite src/version.ts's YOMI_VERSION to match package.json's "version".
 *
 * Run automatically by the `version` npm lifecycle script (i.e. by
 * `npm version patch|minor|major`), so the two version sources can never
 * drift. Node-only, zero deps — works in any environment npm runs in.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const versionFile = new URL('../src/version.ts', import.meta.url);
const infoPlistFile = new URL('../desktop/mac-native/Info.plist', import.meta.url);
const cargoFile = new URL('../desktop/Cargo.toml', import.meta.url);
const src = readFileSync(versionFile, 'utf8');

// No trailing \s* here: it would match the file's final newline and the
// replacement would drop it, leaving a file that fails `biome check` — so
// every `npm version` bump would land a lint failure on main.
const pattern = /(export const YOMI_VERSION = ')[^']*(')/;
if (!pattern.test(src)) {
  console.error('sync-version: could not find the YOMI_VERSION line in src/version.ts');
  process.exit(1);
}

const next = src.replace(pattern, `$1${pkg.version}$2`);
if (next !== src) {
  writeFileSync(versionFile, next);
}

const infoPlist = readFileSync(infoPlistFile, 'utf8');
const nextInfoPlist = infoPlist.replace(
  /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+(<\/string>)/,
  `$1${pkg.version}$2`,
).replace(
  /(<key>CFBundleVersion<\/key>\s*<string>)[^<]+(<\/string>)/,
  `$1${pkg.version}$2`,
);
if (nextInfoPlist === infoPlist && !infoPlist.includes(`<string>${pkg.version}</string>`)) {
  console.error('sync-version: could not update CFBundleShortVersionString');
  process.exit(1);
}
writeFileSync(infoPlistFile, nextInfoPlist);

const cargo = readFileSync(cargoFile, 'utf8');
const nextCargo = cargo.replace(/^(version = ")[^"]+("$)/m, `$1${pkg.version}$2`);
if (nextCargo === cargo && !cargo.includes(`version = "${pkg.version}"`)) {
  console.error('sync-version: could not update desktop/Cargo.toml version');
  process.exit(1);
}
writeFileSync(cargoFile, nextCargo);

console.log(`sync-version: core and desktop versions -> ${pkg.version}`);
