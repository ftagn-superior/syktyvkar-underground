import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { inspectReactionCatalog } from './catalog.js';
import { addReaction } from './add.js';

const usage = `Команды:
  pnpm reactions:check
  pnpm reactions:add --id bravo --label "Браво" --category "Общение" [--asset ./bravo.svg] [--dry-run]
Без --asset создаётся SVG-заготовка. Руководство: docs/reactions.md.`;
try {
  const [command, ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      id: { type: 'string' },
      label: { type: 'string' },
      category: { type: 'string' },
      asset: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(usage);
  else if (command === 'check' && args.length === 0) {
    const result = await inspectReactionCatalog(process.cwd());
    console.log(
      `Реакции: ${result.definitions.length} записей и SVG проверены; версия ${result.version}`,
    );
  } else if (command === 'add' && values.id && values.label && values.category) {
    const result = await addReaction(process.cwd(), {
      id: values.id,
      label: values.label,
      category: values.category,
      assetFile: values.asset ? resolve(values.asset) : undefined,
      dryRun: values['dry-run'],
    });
    console.log(
      `${result.dryRun ? 'Проверено без записи' : 'Добавлено'}: ${result.entry.id}; ${result.entry.asset}`,
    );
    console.log(`Версия каталога: ${result.version}`);
    console.log(
      'Далее: проверьте рисунок, pnpm reactions:check, pnpm build, SU_TEST_DATABASE_URL=… pnpm test:reactions:browser. Выпуск клиента и сервера — вместе; docs/reactions.md.',
    );
  } else throw new Error(usage);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
