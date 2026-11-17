import type { BuildIdentity } from '@su/contracts';
declare const __SU_BUILD_INFO__: BuildIdentity;
/** Source/dev execution has no deployed artifact identity. */
export const SERVER_BUILD: BuildIdentity | null =
  typeof __SU_BUILD_INFO__ === 'undefined' ? null : __SU_BUILD_INFO__;
