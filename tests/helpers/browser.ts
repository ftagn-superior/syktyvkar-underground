import { chromium } from 'playwright';

/** Keep software rendering settings identical; native-focus checks need full Chromium. */
export function launchTestBrowser({
  renderer = 'software',
  channel,
  args = [],
  headless = true,
}: {
  renderer?: 'software' | 'default';
  channel?: 'chromium';
  args?: string[];
  headless?: boolean;
} = {}) {
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    channel,
    headless,
    args: [
      ...(renderer === 'software'
        ? ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader']
        : []),
      ...args,
    ],
  });
}
