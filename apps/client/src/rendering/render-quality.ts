export type RenderQuality = 'standard' | 'economy';

/** Visual settings only: changing quality never changes simulation or network timing. */
export function renderQualitySettings(quality: RenderQuality, pixelRatio: number) {
  const standardScaling = Math.max(1, pixelRatio / 1.5);
  return {
    shadows: quality === 'standard',
    hardwareScaling: standardScaling * (quality === 'economy' ? 1.5 : 1),
  };
}
