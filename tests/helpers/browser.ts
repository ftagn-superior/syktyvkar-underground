import { chromium } from 'playwright';

/** Keep the browser binary and software rendering settings identical across scenarios. */
export function launchTestBrowser({
  renderer = 'software',
  args = [],
}: { renderer?: 'software' | 'default'; args?: string[] } = {}) {
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    headless: true,
    args: [
      ...(renderer === 'software'
        ? ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader']
        : []),
      ...args,
    ],
  });
}
