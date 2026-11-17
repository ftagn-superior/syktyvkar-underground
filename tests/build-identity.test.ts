import { describe, expect, it } from 'vitest';
import { readBuildIdentity } from '../packages/contracts/src/build-identity';
import { buildIdentity } from '../tools/build-identity';

const sha = '1234567890abcdef1234567890abcdef12345678';
const base = { builtAt: '2026-11-17T10:00:00.000Z', version: '0.1.0' };
describe('artifact build identity', () => {
  it('embeds the actual source revision and dirty status at build time', () => {
    const result = buildIdentity({
      ...base,
      env: {},
      git: (args) => (args[0] === 'rev-parse' ? sha : ' M source.ts'),
    });
    expect(result).toMatchObject({
      commit: sha,
      dirty: true,
      source: 'git',
      buildId: `${sha}-dirty@${base.builtAt}`,
    });
    expect(readBuildIdentity(result)).toEqual(result);
  });
  it('supports source archives and never invents a current runtime HEAD', () => {
    const git = () => {
      throw new Error('no git');
    };
    expect(buildIdentity({ ...base, env: {}, git })).toEqual({
      ...base,
      commit: null,
      buildId: null,
      dirty: null,
      source: 'unavailable',
    });
    expect(
      buildIdentity({ ...base, env: { SU_BUILD_SHA: sha, SU_BUILD_ID: 'release-17' }, git }),
    ).toMatchObject({ commit: sha, buildId: 'release-17', dirty: null, source: 'environment' });
  });
  it('rejects a short or arbitrary deployment SHA and treats old/malformed server metadata as unknown', () => {
    expect(() => buildIdentity({ ...base, env: { SU_BUILD_SHA: 'main' } })).toThrow('full Git SHA');
    expect(readBuildIdentity(undefined)).toBeNull();
    expect(readBuildIdentity({ version: '0.1.0', builtAt: base.builtAt })).toBeNull();
    expect(
      readBuildIdentity({ ...base, commit: 'HEAD', buildId: null, dirty: null, source: 'git' }),
    ).toBeNull();
  });
});
