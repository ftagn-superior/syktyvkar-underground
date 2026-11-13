import type { AvatarSkinId, SimulationConfig } from '@su/contracts';
import type { AvatarRig } from '../avatar-rig';
import { buildBear, buildBearWheelchair } from './bear';
import { buildKomiGirl, buildKomiGuy } from './komi';
import { buildMinifigure } from './minifigure';
import { buildGirl, buildGuy } from './people';
import { buildStandard } from './standard';

export const SKIN_BUILDERS: Record<
  AvatarSkinId,
  (rig: AvatarRig, config: SimulationConfig['character']) => void
> = {
  standard: buildStandard,
  guy: buildGuy,
  girl: buildGirl,
  'komi-guy': buildKomiGuy,
  'komi-girl': buildKomiGirl,
  minifigure: buildMinifigure,
  bear: buildBear,
  'bear-wheelchair': buildBearWheelchair,
};
