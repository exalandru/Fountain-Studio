/**
 * Verifies that the dependency tree contains no copyleft licence, then generates
 * THIRD-PARTY-NOTICES.md.
 *
 * Project decision (PLAN.md §2.1): only permissive licences are admitted. Any unknown
 * licence counts as a violation — an `UNKNOWN` must be resolved by hand, not ignored.
 *
 * Usage: npm run check:licenses
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'CC-BY-4.0',
  'ISC',
  'MIT',
  'MIT-0',
  'OFL-1.1',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);

/** Explicitly rejected licences — any match fails the check outright. */
const FORBIDDEN = /\b(A?GPL|LGPL|SSPL|BUSL|CDDL|EPL|MPL|CPAL|OSL)\b/i;

/**
 * Audited manifest corrections for packages that ship a licence file without
 * declaring it in package.json. Keep these entries exact and documented in PLAN.md.
 */
const LICENSE_OVERRIDES = new Map([['png-js@1.1.0', 'MIT']]);

interface Pkg {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  licenses?: Array<{ type?: string }> | string;
  private?: boolean;
}

interface Entry {
  name: string;
  version: string;
  license: string;
  path: string;
  notice: string | null;
}

/** Normalises the `license` field, which has three historical shapes in npm. */
function readLicense(pkg: Pkg): string {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => l.type).filter((t): t is string => Boolean(t));
    if (types.length > 0) return types.join(' OR ');
  }
  if (typeof pkg.licenses === 'string') return pkg.licenses;
  return 'UNKNOWN';
}

/**
 * An SPDX expression is accepted when:
 *  - it is an OR with at least one permissive branch (we can pick that branch);
 *  - it is an AND whose every branch is permissive.
 */
function isAllowed(expr: string): boolean {
  const cleaned = expr.replace(/[()]/g, ' ').trim();
  if (ALLOWED.has(cleaned)) return true;

  if (/\bOR\b/i.test(cleaned)) {
    return cleaned.split(/\bOR\b/i).some((branch) => isAllowed(branch.trim()));
  }
  if (/\bAND\b/i.test(cleaned)) {
    return cleaned.split(/\bAND\b/i).every((branch) => isAllowed(branch.trim()));
  }
  return ALLOWED.has(cleaned.replace(/\+$/, ''));
}

/** Reads the licence/copyright notice shipped by a package, when present. */
function readNotice(packagePath: string): string | null {
  try {
    const candidate = readdirSync(packagePath)
      .filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name))
      .sort()[0];
    if (!candidate) return null;
    const path = join(packagePath, candidate);
    if (!statSync(path).isFile()) return null;
    const notice = readFileSync(path, 'utf8').trim();
    return notice.length > 0 ? notice : null;
  } catch {
    return null;
  }
}

interface LockPackage extends Pkg {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface PackageLock {
  packages?: Record<string, LockPackage>;
}

function resolveDependency(
  packages: Record<string, LockPackage>,
  from: string,
  name: string,
): string | null {
  let directory = from;
  while (true) {
    const candidate = directory ? `${directory}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    const parentMarker = directory.lastIndexOf('/node_modules/');
    if (parentMarker === -1) {
      if (directory === '') return null;
      directory = '';
    } else {
      directory = directory.slice(0, parentMarker);
    }
  }
}

/**
 * Walks the dependency graph recorded by package-lock.json.
 *
 * Auditing the lock graph is deterministic and ignores extraneous packages left in a
 * developer's node_modules. Installed manifests are still read as a fallback for old
 * lock entries and to collect their licence texts.
 */
function collectLocked(root: string, out: Map<string, Entry>): void {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as PackageLock;
  const packages = lock.packages;
  const rootPackage = packages?.[''];
  if (!packages || !rootPackage) throw new Error('Invalid package-lock.json: packages are missing');

  const queue: string[] = [];
  const visited = new Set<string>();
  const enqueueDependencies = (from: string, pkg: LockPackage) => {
    const dependencies = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    };
    for (const name of Object.keys(dependencies)) {
      const resolved = resolveDependency(packages, from, name);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  };

  enqueueDependencies('', rootPackage);
  while (queue.length > 0) {
    const lockPath = queue.shift();
    if (!lockPath || visited.has(lockPath)) continue;
    visited.add(lockPath);

    const locked = packages[lockPath];
    if (!locked) continue;
    const installedPath = join(root, lockPath);
    let manifest: Pkg | null = null;
    try {
      manifest = JSON.parse(readFileSync(join(installedPath, 'package.json'), 'utf8')) as Pkg;
    } catch {
      // Missing installed package is acceptable for platform-specific optional entries;
      // its auditable name/version/licence must still be present in the lock.
    }

    const name = locked.name ?? manifest?.name ?? lockPath.split('/node_modules/').at(-1);
    const version = locked.version ?? manifest?.version;
    const declaredLicense =
      readLicense(locked) === 'UNKNOWN' ? readLicense(manifest ?? {}) : readLicense(locked);
    if (!name || !version) {
      out.set(`unreadable:${lockPath}`, {
        name: `[incomplete lock entry: ${lockPath}]`,
        version: version ?? '?',
        license: 'UNKNOWN',
        path: installedPath,
        notice: null,
      });
    } else {
      const key = `${name}@${version}`;
      const license = LICENSE_OVERRIDES.get(key) ?? declaredLicense;
      if (!out.has(key)) {
        out.set(key, {
          name,
          version,
          license,
          path: installedPath,
          notice: readNotice(installedPath),
        });
      }
    }

    enqueueDependencies(lockPath, locked);
  }
}

const root = resolve(import.meta.dirname, '..');
const packages = new Map<string, Entry>();
collectLocked(root, packages);

if (packages.size === 0) {
  console.error('No dependency found — run `npm install` first.');
  process.exit(1);
}

const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
const violations = sorted.filter((e) => FORBIDDEN.test(e.license) || !isAllowed(e.license));

const byLicense = new Map<string, number>();
for (const entry of sorted) byLicense.set(entry.license, (byLicense.get(entry.license) ?? 0) + 1);

console.log(`${sorted.length} packages analysed.\n`);
console.log('Licence breakdown:');
for (const [license, count] of [...byLicense.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${license}`);
}

if (violations.length > 0) {
  console.error(`\n✗ ${violations.length} disallowed licence(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.name}@${v.version} — ${v.license}`);
  }
  console.error('\nAllowlist: ' + [...ALLOWED].sort().join(', '));
  console.error('See PLAN.md §2.1. Remove the dependency or resolve the licence explicitly.');
  process.exit(1);
}

const notices = [
  '# Third-party notices',
  '',
  'Quantum Draft builds on the packages below. Generated by `npm run check:licenses`.',
  '',
  '| Package | Version | Licence |',
  '|---|---|---|',
  ...sorted.map((e) => `| ${e.name} | ${e.version} | ${e.license} |`),
  '',
  '## Licence and copyright texts',
  '',
  ...(() => {
    const grouped = new Map<string, string[]>();
    for (const entry of sorted) {
      if (!entry.notice) continue;
      const packagesForNotice = grouped.get(entry.notice) ?? [];
      packagesForNotice.push(`${entry.name}@${entry.version}`);
      grouped.set(entry.notice, packagesForNotice);
    }
    return [...grouped.entries()].flatMap(([notice, packageNames]) => [
      `### ${packageNames.join(', ')}`,
      '',
      ...notice.split('\n').map((line) => {
        const normalized = line.trimEnd().replaceAll('\t', '    ');
        return normalized ? `    ${normalized}` : '';
      }),
      '',
    ]);
  })(),
];
writeFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), notices.join('\n'), 'utf8');

console.log('\n✓ All licences are permissive. THIRD-PARTY-NOTICES.md regenerated.');
