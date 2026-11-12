export type RenderQuality = 'standard' | 'economy';

/** Visual settings only: changing quality never changes simulation or network timing. */
export function renderQualitySettings(quality: RenderQuality) {
  return {
    shadows: quality === 'standard',
    hardwareScaling: quality === 'economy' ? 1.5 : 1,
  };
}
