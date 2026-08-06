import { error, log } from 'node:console';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const docsRoot = join(root, 'docs');
const errors = [];

function filesUnder(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path, extension) : extname(path) === extension ? [path] : [];
  });
}

const docs = filesUnder(docsRoot, '.md');
const layers = new Set([
  '01-architecture',
  '02-standards',
  '03-workflows',
  '04-design',
  '05-experience',
  '06-archive',
  '07-templates',
  '08-review',
  '09-plan',
]);
for (const entry of readdirSync(docsRoot, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    if (!layers.has(entry.name)) fail(join(docsRoot, entry.name), 'unknown documentation layer');
    if (!existsSync(join(docsRoot, entry.name, 'README.md'))) fail(join(docsRoot, entry.name), 'documentation layer is missing README.md');
  } else if (entry.name !== 'README.md') {
    fail(join(docsRoot, entry.name), 'root docs directory may contain only README.md and governed layers');
  }
}
const requiredMetadata = [
  '治理版本',
  '事实状态',
  '生命周期',
  '实施状态',
  'SSOT 同步',
  '对应事实源',
  '替代关系',
  '最后复核时间',
];
const allowed = {
  事实状态: new Set(['current', 'current-with-known-gaps', 'target', 'n/a']),
  生命周期: new Set(['draft', 'proposed', 'accepted', 'active', 'historical']),
  实施状态: new Set(['not-started', 'in-progress', 'completed', 'n/a']),
  'SSOT 同步': new Set(['pending', 'partial', 'synced', 'n/a']),
};

function fail(path, message) {
  errors.push(`${relative(root, path)}: ${message}`);
}

function metadataOf(path) {
  const metadata = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^> ([^：]+)：(.+)$/.exec(line);
    if (!match) break;
    metadata.set(match[1], match[2].trim());
  }
  return metadata;
}

for (const path of docs) {
  const metadata = metadataOf(path);
  for (const field of requiredMetadata) {
    if (!metadata.has(field)) fail(path, `missing metadata: ${field}`);
  }
  if (metadata.get('治理版本') !== '2') fail(path, '治理版本 must be 2');
  for (const [field, values] of Object.entries(allowed)) {
    const value = metadata.get(field);
    if (value !== undefined && !values.has(value)) fail(path, `invalid ${field}: ${value}`);
  }
  const docPath = relative(docsRoot, path).split(sep).join('/');
  const fact = metadata.get('事实状态');
  const lifecycle = metadata.get('生命周期');
  const implementation = metadata.get('实施状态');
  if (docPath === 'README.md' || docPath.startsWith('01-architecture/') || docPath.startsWith('03-workflows/')) {
    if (!new Set(['current', 'current-with-known-gaps', 'target']).has(fact)) fail(path, 'current documentation must declare a current or target fact status');
    if (lifecycle !== 'active') fail(path, 'current documentation must be active');
    if (implementation !== 'n/a') fail(path, 'current documentation implementation status must be n/a');
  } else if (docPath.startsWith('02-standards/')) {
    if (fact !== 'current' || lifecycle !== 'active' || implementation !== 'n/a') fail(path, 'standards must be current, active, and implementation n/a');
  } else if (docPath.startsWith('04-design/')) {
    if (fact !== 'n/a' || !new Set(['draft', 'proposed', 'accepted', 'active']).has(lifecycle)) fail(path, 'design documents must be fact n/a and have an active design lifecycle');
    if (!new Set(['not-started', 'in-progress', 'completed']).has(implementation)) fail(path, 'design documents must declare implementation progress');
  } else if (docPath.startsWith('05-experience/') || docPath.startsWith('08-review/')) {
    if (fact !== 'n/a' || !new Set(['active', 'historical']).has(lifecycle) || implementation !== 'n/a') fail(path, 'experience and review documents must be fact n/a, active or historical, and implementation n/a');
  } else if (docPath.startsWith('06-archive/')) {
    if (fact !== 'n/a' || lifecycle !== 'historical') fail(path, 'archive documents must be fact n/a and historical');
    if (docPath !== '06-archive/README.md' && !docPath.endsWith('/README.md')) {
      for (const field of ['归档原因', '原始路径', '归档时间']) {
        if (!metadata.has(field)) fail(path, `missing archive metadata: ${field}`);
      }
    }
  } else if (docPath.startsWith('09-plan/')) {
    if (fact !== 'n/a' || !new Set(['accepted', 'active']).has(lifecycle)) fail(path, 'plan documents must be fact n/a and accepted or active');
    if (!new Set(['not-started', 'in-progress', 'completed']).has(implementation)) fail(path, 'plan documents must declare implementation progress');
  }
}

const markdown = [
  ...docs,
  ...['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md']
    .map((path) => join(root, path))
    .filter(existsSync),
  ...filesUnder(join(root, '.github'), '.md'),
];
const linkPattern = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
for (const path of markdown) {
  const content = readFileSync(path, 'utf8');
  for (const match of content.matchAll(linkPattern)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '');
    const target = rawTarget.split('#', 1)[0].split('?', 1)[0];
    if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    const resolved = normalize(resolve(dirname(path), decodeURIComponent(target)));
    if (!resolved.startsWith(`${root}${sep}`) && resolved !== root) {
      fail(path, `link escapes repository: ${rawTarget}`);
    } else if (!existsSync(resolved)) {
      fail(path, `broken local link: ${rawTarget}`);
    }
  }
}

if (errors.length > 0) {
  error(errors.join('\n'));
  process.exitCode = 1;
} else {
  log(`Documentation check passed: ${docs.length} governed documents, ${markdown.length} Markdown files.`);
}
