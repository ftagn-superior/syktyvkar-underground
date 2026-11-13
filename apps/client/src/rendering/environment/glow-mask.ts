import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import { EffectWrapper } from '@babylonjs/core/Materials/effectRenderer';
import '@babylonjs/core/Shaders/extractHighlights.fragment';
import '@babylonjs/core/Shaders/bloomMerge.fragment';

/**
 * Ореол только у огней, а не у всего яркого.
 *
 * Шейдер ночных огней помечает светящиеся пиксели отрицательной альфой в HDR-буфере
 * сцены (`WorldNightLights.setGlowMask`). Непрозрачная сцена пишет альфу 0..1,
 * а прозрачные слои (облака, затухающие дома) при смешивании только прибавляют её,
 * поэтому отрицательное значение может оставить лишь огонь. Слой облаков поверх
 * огня ослабляет метку, как и должен.
 *
 * Здесь переписываются два прохода ореола Babylon: выделение берёт цвет по метке,
 * а не по порогу яркости, и слияние возвращает альфу 1, чтобы метка не дошла до
 * холста (у него есть альфа-канал).
 */
const PASSES = {
  /** Имя `ExtractHighlightsPostProcess` внутри `BloomEffect`. */
  highlights: {
    shader: 'extractHighlightsPixelShader',
    find: 'gl_FragColor.rgb=step(threshold,luma)*gl_FragColor.rgb;',
    replace: 'gl_FragColor.rgb*=clamp(-gl_FragColor.a,0.0,1.0);',
  },
  /** Имя `BloomMergePostProcess` внутри `BloomEffect`. */
  bloomMerge: {
    shader: 'bloomMergePixelShader',
    find: 'gl_FragColor.rgb=gl_FragColor.rgb+(blurred.rgb*bloomWeight);',
    replace: 'gl_FragColor.rgb=gl_FragColor.rgb+(blurred.rgb*bloomWeight);gl_FragColor.a=1.0;',
  },
} as const;

/**
 * Совпадают ли проходы Babylon с ожидаемым кодом. Если после обновления Babylon нет,
 * метка не включается и ореол работает по старому порогу яркости.
 */
export const GLOW_MASK_SUPPORTED = Object.values(PASSES).every(({ shader, find }) =>
  ShaderStore.ShadersStore[shader]?.includes(find),
);

/** Сколько раз проходы переписаны при компиляции; для диагностики. */
export const glowMaskPatches = { highlights: 0, bloomMerge: 0 };

if (GLOW_MASK_SUPPORTED)
  for (const name of Object.keys(PASSES) as (keyof typeof PASSES)[]) {
    const pass: { find: string; replace: string } = PASSES[name];
    EffectWrapper.RegisterShaderCodeProcessing(name, {
      processCodeAfterIncludes: (_name, shaderType, code) => {
        if (shaderType !== 'fragment' || !code.includes(pass.find)) return code;
        glowMaskPatches[name]++;
        return code.replace(pass.find, pass.replace);
      },
    });
  }
