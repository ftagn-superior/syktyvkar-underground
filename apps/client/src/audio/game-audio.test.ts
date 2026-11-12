import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameAudio } from './game-audio';
import { AUDIO_SAMPLES, MAX_UI_VOICES, MAX_WORLD_VOICES } from './policy';

const mock = vi.hoisted(() => ({ failures: new Set<string>(), engine: undefined as any }));
vi.mock('@babylonjs/core/AudioV2/webAudio/webAudioEngine', () => ({
  CreateAudioEngineAsync: async () => {
    const vector = () => ({ set: vi.fn() });
    const engine = {
      state: 'suspended',
      volume: 1,
      listener: { position: vector(), rotation: vector(), update: vi.fn() },
      createBusAsync: async () => ({ volume: 1 }),
      createSoundBufferAsync: async (path: string) => {
        if ([...mock.failures].some((file) => path.includes(file))) throw new Error('missing');
        return { duration: 0.5 };
      },
      createSoundAsync: async (_name: string, buffer: { duration: number }) => ({
        state: 1,
        buffer,
        playbackRate: 1,
        spatial: { position: vector(), update: vi.fn() },
        play: vi.fn(),
        stop: vi.fn(),
        dispose: vi.fn(),
      }),
      unlockAsync: async () => {
        engine.state = 'running';
      },
      pauseAsync: async () => {
        engine.state = 'suspended';
      },
      dispose: () => {
        engine.state = 'closed';
      },
    };
    mock.engine = engine;
    return engine;
  },
}));

describe('GameAudio lifecycle and voice limits', () => {
  let audio: GameAudio;
  beforeEach(() => {
    mock.failures.clear();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  });
  afterEach(() => {
    audio?.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const prepare = async () => {
    audio = new GameAudio();
    await vi.waitFor(() => expect(audio.diagnostics().ready).toBe(true));
    audio.setListener({ x: 0, y: 0, z: 0 });
  };

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
