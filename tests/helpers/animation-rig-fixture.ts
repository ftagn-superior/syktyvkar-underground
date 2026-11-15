import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { animationCommand, syncAnimations } from '../../tools/animations';
import { rigDefinitions } from '../fixtures/animation-rig';

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? done() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

/** Isolated source/release: no debug catalog or bypass is added to the real working tree.
 * Run after pnpm build. World publications are shared read-only; client/server are rebuilt.
 */
export async function prepareAnimationRigFixture() {
  const original = process.cwd();
  const output = resolve('output/playwright/rig-v2');
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(join(output, 'source-'));
  for (const name of [
    'apps',
    'packages',
    'tools',
    'tests',
    'content',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'vitest.config.ts',
    '.prettierrc.json',
  ])
    await cp(resolve(original, name), join(root, name), {
      recursive: true,
      verbatimSymlinks: true,
    });
  await symlink(resolve(original, 'node_modules'), join(root, 'node_modules'), 'dir');
  await mkdir(join(root, 'dist'), { recursive: true });
  for (const name of ['worlds', 'model-catalogs'])
    await symlink(resolve(original, 'dist', name), join(root, 'dist', name), 'dir');
  for (const definition of rigDefinitions) {
    if (definition.rig !== 'humanoid-v2') throw new Error('Expected v2 fixture');
    await animationCommand(root, [
      'add',
      '--id',
      definition.id,
      '--label',
      definition.label,
      '--category',
      definition.category,
      '--mode',
      definition.mode,
      '--rig',
      definition.rig,
      '--support',
      definition.support,
      '--seated',
      definition.seated,
      '--seated-message',
      definition.seatedMessage!,
      '--reduced-motion',
      definition.reducedMotion,
      '--reduced-motion-label',
      definition.reducedMotionLabel!,
      '--period-ms',
      definition.id === 'rig-cartwheel' ? '6000' : '4000',
    ]);
    const file = join(root, 'apps/client/src/rendering/avatars/clips', definition.id + '.ts');
    const source = await readFile(
      resolve(original, 'tests/fixtures/animation-rig', definition.id.slice(4) + '.ts'),
      'utf8',
    );
    await writeFile(
      file,
      source.replaceAll('../../../apps/client/src/rendering/avatars/clips/types', './types'),
    );
    await syncAnimations(root);
  }
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], root);
  await run(process.execPath, ['--import', 'tsx', 'tools/build.mjs'], root);
  return { original, root, output };
}
