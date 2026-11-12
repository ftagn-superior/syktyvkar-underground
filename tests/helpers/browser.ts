import { chromium } from 'playwright';

/** Keep software rendering settings identical; native-focus checks need full Chromium. */
export function launchTestBrowser({
  renderer = 'software',
  channel,
  args = [],
}: { renderer?: 'software' | 'default'; channel?: 'chromium'; args?: string[] } = {}) {
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    channel,
    headless: true,
    args: [
      ...(renderer === 'software'
        ? ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader']
        : []),
      ...args,
    ],
  });
}
