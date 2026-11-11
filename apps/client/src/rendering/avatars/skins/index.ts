import type { AvatarSkinId, SimulationConfig } from '@su/contracts';
import type { AvatarRig } from '../avatar-rig';
import { buildMinifigure } from './minifigure';
import { buildStandard } from './standard';

export const SKIN_BUILDERS: Record<
  AvatarSkinId,
  (rig: AvatarRig, config: SimulationConfig['character']) => void
> = {
  minifigure: buildMinifigure,
  standard: buildStandard,
};
