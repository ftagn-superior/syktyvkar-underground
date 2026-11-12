import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameAudio } from './game-audio';
import { AUDIO_SAMPLES, MAX_UI_VOICES, MAX_WORLD_VOICES } from './policy';

const mock = vi.hoisted(() => ({
  failures: new Set<string>(),
  engine: undefined as any,
  context: undefined as any,
  deferPause: false,
  finishPause: undefined as (() => void) | undefined,
}));
vi.mock('@babylonjs/core/AudioV2/webAudio/webAudioEngine', async (importOriginal) => {
  const { _WebAudioEngine } =
    await importOriginal<typeof import('@babylonjs/core/AudioV2/webAudio/webAudioEngine')>();
  return {
    CreateAudioEngineAsync: async (options: object) => {
      const vector = () => ({ set: vi.fn() });
      // Keep Babylon's actual pause/resume cache and statechange handler. Only the browser
      // device and sample decoding are replaced, so lifecycle regressions are not mocked away.
      class Context extends EventTarget {
        state = 'suspended';
        listener = { setPosition: vi.fn(), setOrientation: vi.fn() };
        resume = vi.fn(async () => {
          if (this.state !== 'running') {
            this.state = 'running';
            queueMicrotask(() => this.dispatchEvent(new Event('statechange')));
          }
        });
        suspend = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              const finish = () => {
                this.state = 'suspended';
                resolve();
                queueMicrotask(() => this.dispatchEvent(new Event('statechange')));
              };
              if (mock.deferPause) mock.finishPause = finish;
              else queueMicrotask(finish);
            }),
        );
        close = async () => {
          this.state = 'closed';
        };
      }
      const context = new Context();
      const engine = new _WebAudioEngine({
        ...options,
        audioContext: context as unknown as AudioContext,
      }) as any;
      engine._initAudioContextAsync = async () =>
        context.addEventListener('statechange', engine._onAudioContextStateChange);
      await engine._initAsync(options);
      engine.createBusAsync = async () => ({ volume: 1 });
      engine.createSoundBufferAsync = async (path: string) => {
        if ([...mock.failures].some((file) => path.includes(file))) throw new Error('missing');
        return { duration: 0.5 };
      };
      engine.createSoundAsync = async (_name: string, buffer: { duration: number }) => ({
        state: 1,
        buffer,
        playbackRate: 1,
        spatial: { position: vector(), update: vi.fn() },
        play: vi.fn(),
        stop: vi.fn(),
        dispose: vi.fn(),
      });
      mock.engine = engine;
      mock.context = context;
      return engine;
    },
  };
});

describe('GameAudio lifecycle and voice limits', () => {
  let audio: GameAudio;
  beforeEach(() => {
    mock.failures.clear();
    mock.deferPause = false;
    mock.finishPause = undefined;
    vi.stubGlobal('OfflineAudioContext', class {});
    vi.stubGlobal('document', new EventTarget());
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  });
  afterEach(() => {
    audio?.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const prepare = async () => {
    audio = new GameAudio();
    await vi.waitFor(() => expect(audio.diagnostics().ready).toBe(true));
    audio.setListener({ x: 0, y: 0, z: 0 });
  };

  it('does not poison Babylon resume cache on ordinary key presses while already running', async () => {
    await prepare();
    audio.unlock();
    await Promise.resolve();
    await vi.waitFor(() => expect(audio.diagnostics().contextTransition ?? false).toBe(false));
    audio.unlock(); // A subsequent movement keydown must not call native resume again.
    await Promise.resolve();
    audio.setActive(false);
    await vi.waitFor(() => expect(mock.engine.state).toBe('suspended'));
    audio.setActive(true);
    await vi.waitFor(() => expect(mock.engine.state).toBe('running'));
    audio.playUi('click');
    expect(audio.diagnostics().played['ui:click']).toBe(1);
  });

  it('reconciles a delayed pause with focus returning before suspend completes', async () => {
    await prepare();
    audio.unlock();
    await Promise.resolve();
    await vi.waitFor(() => expect(audio.diagnostics().contextTransition ?? false).toBe(false));
    mock.deferPause = true;
    audio.setActive(false);
    audio.setActive(true);
    mock.finishPause!();
    await vi.waitFor(() => expect(mock.engine.state).toBe('running'));
    audio.playUi('click');
    expect(audio.diagnostics().played['ui:click']).toBe(1);
  });

  it('recovers external browser suspension without a new gesture, but never retries in the background', async () => {
    vi.useFakeTimers();
    await prepare();
    audio.unlock();
    await Promise.resolve();
    await mock.context.suspend(); // OS/browser interruption, not GameAudio.setActive(false).
    await vi.advanceTimersByTimeAsync(1500);
    expect(mock.engine.state).toBe('running');
    audio.playUi('click');
    expect(audio.diagnostics().played['ui:click']).toBe(1);
    audio.setActive(false);
    await vi.advanceTimersByTimeAsync(2500);
    expect(mock.engine.state).toBe('suspended');
    const resumeCalls = mock.context.resume.mock.calls.length;
    audio.dispose();
    await vi.advanceTimersByTimeAsync(2500);
    expect(mock.context.resume.mock.calls.length).toBe(resumeCalls);
  });

  it('drops blocked events without replay after unlock or returning to the tab', async () => {
    await prepare();
    audio.playUi('spawn');
    expect(audio.diagnostics().played).toEqual({});
    audio.unlock();
    await Promise.resolve();
    expect(audio.diagnostics().played).toEqual({});
    audio.playUi('spawn');
    expect(audio.diagnostics().played['ui:spawn']).toBe(1);
    audio.setActive(false);
    audio.playWorld('step', { x: 0, y: 0, z: 0 });
    expect(audio.diagnostics().activeUiVoices).toBe(0);
    audio.setActive(true);
    await Promise.resolve();
    expect(audio.diagnostics().played.step).toBeUndefined();
    audio.playWorld('step', { x: 0, y: 0, z: 0 });
    expect(audio.diagnostics().played.step).toBe(1);
  });

  it('survives an unavailable recording and continues using the other variants', async () => {
    mock.failures.add('footstep_concrete_000');
    await prepare();
    expect(audio.diagnostics().loadedAssets).toBe(AUDIO_SAMPLES.length - 1);
    expect(audio.diagnostics().failedAssets).toBe(1);
    audio.unlock();
    await Promise.resolve();
    audio.playWorld('step', { x: 1, y: 0, z: 0 });
    audio.playUi('open');
    expect(audio.diagnostics().played.step).toBe(1);
    expect(audio.diagnostics().played['ui:open']).toBe(1);
  });

  it('cuts off remote and absent-listener sounds before allocating any voice', async () => {
    await prepare();
    audio.unlock();
    await Promise.resolve();
    audio.playWorld('step', { x: 18, y: 0, z: 0 });
    audio.playWorld('run', { x: 24, y: 0, z: 0 });
    expect(audio.diagnostics().activeWorldVoices).toBe(0);
    audio.setListener(undefined);
    audio.playWorld('impact', { x: 0, y: 0, z: 0 });
    expect(audio.diagnostics().activeWorldVoices).toBe(0);
    audio.playUi('click');
    expect(audio.diagnostics().played['ui:click']).toBe(1);
  });

  it('bounds simultaneous world/UI voices under bursts and stops them on mute/dispose', async () => {
    await prepare();
    audio.unlock();
    await Promise.resolve();
    let random = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => ((random++ * 17) % 100) / 100);
    const types = ['wooden-crate', 'watermelon-ball', 'giant-domino', 'giant-soap'];
    for (let index = 0; index < 80; index++) {
      audio.playWorld(
        index % 3 === 0 ? 'step' : 'impact',
        { x: 1, y: 0, z: 0 },
        {
          sourceId: `source-${index}`,
          typeId: types[index % types.length],
        },
      );
      expect(audio.diagnostics().activeWorldVoices).toBeLessThanOrEqual(MAX_WORLD_VOICES);
    }
    for (const cue of ['click', 'pickup', 'spawn', 'error', 'open'] as const) audio.playUi(cue);
    expect(audio.diagnostics().activeWorldVoices).toBeGreaterThan(0);
    expect(audio.diagnostics().activeUiVoices).toBeLessThanOrEqual(MAX_UI_VOICES);
    expect(audio.diagnostics().dropped).toBeGreaterThan(0);
    audio.updateSettings({ muted: true });
    expect(audio.diagnostics().activeWorldVoices).toBe(0);
    expect(audio.diagnostics().activeUiVoices).toBe(0);
    audio.dispose();
    expect(mock.engine.state).toBe('closed');
    expect(audio.diagnostics().totalVoices).toBe(0);
  });
});
