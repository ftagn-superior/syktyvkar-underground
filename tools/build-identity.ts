import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BuildIdentity } from '../packages/contracts/src/build-identity';

const root = fileURLToPath(new URL('..', import.meta.url));
export function buildIdentity(
  options: {
    env?: NodeJS.ProcessEnv;
    git?: (args: string[]) => string;
    builtAt?: string;
    version?: string;
  } = {},
): BuildIdentity {
  const env = options.env ?? process.env;
  const git =
    options.git ??
    ((args) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim());
  const builtAt = options.builtAt ?? new Date().toISOString();
  const version =
    options.version ??
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  let commit: string | null = null,
    dirty: boolean | null = null;
  let source: BuildIdentity['source'] = 'unavailable';
  if (env.SU_BUILD_SHA) {
    if (!/^[0-9a-f]{40}$/i.test(env.SU_BUILD_SHA))
      throw new Error('SU_BUILD_SHA must be a full Git SHA');
    commit = env.SU_BUILD_SHA.toLowerCase();
    source = 'environment';
  } else {
    try {
      const head = git(['rev-parse', '--verify', 'HEAD']);
      if (/^[0-9a-f]{40}$/i.test(head)) {
        commit = head.toLowerCase();
        source = 'git';
      }
    } catch {
      /* Source archives can legitimately have no Git metadata. */
    }
  }
  try {
    dirty = git(['status', '--porcelain', '--untracked-files=normal']).length > 0;
  } catch {
    /* Unknown. */
  }
  const buildId =
    env.SU_BUILD_ID ?? (commit ? `${commit}${dirty ? '-dirty' : ''}@${builtAt}` : null);
  if (buildId !== null && !/^[A-Za-z0-9._:@+-]{1,160}$/.test(buildId))
    throw new Error('SU_BUILD_ID must be a short release identifier');
  return { version, builtAt, buildId, commit, dirty, source };
}
