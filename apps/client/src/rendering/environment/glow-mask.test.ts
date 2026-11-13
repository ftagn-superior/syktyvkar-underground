import { describe, expect, it } from 'vitest';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import { GLOW_MASK_SUPPORTED } from './glow-mask';

describe('glow mask', () => {
  // Обновление Babylon может изменить код проходов ореола; тогда метка огней молча
  // отключится и ореол вернётся к порогу яркости. Этот тест замечает это раньше.
  it('recognises the bloom passes it rewrites', () => {
    expect(GLOW_MASK_SUPPORTED).toBe(true);
    expect(ShaderStore.ShadersStore.extractHighlightsPixelShader).toContain('gl_FragColor');
    expect(ShaderStore.ShadersStore.bloomMergePixelShader).toContain('bloomWeight');
  });
});
