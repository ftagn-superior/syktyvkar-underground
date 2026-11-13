import type {
  AreaResult,
  AvatarSkinId,
  ErrorCode,
  MoveInput,
  PrepareArea,
  Vec3,
} from '@su/contracts';
import type { AuthenticatedAccount } from '../accounts/store.js';
import type { ActionLedger } from '../gameplay/action-ledger.js';
import type { PlayerActivities } from '../gameplay/player-activities.js';
import type { PlayerPositionSnapshot } from '../players/position-store.js';

export interface InitialSpawn {
  stage: 'loading-position' | 'saved' | 'default' | 'spawned';
  position?: Vec3;
  startedAt: number;
  deadline: number;
  executionDeadline?: number;
}

export interface PreparationPlan {
  message: PrepareArea;
  deadline: number;
  readyAt?: number;
  spawnDeadline?: number;
}

/** Connection state survives a transport reconnect; physics remains owned by the world. */
export interface PlayerSession {
  plan?: PreparationPlan;
  areaResults: Map<string, AreaResult>;
  entityId: string;
  connected: boolean;
  name: string;
  color: string;
  skinId: AvatarSkinId;
  lastRespawn: number;
  lastInput: MoveInput;
  actions: ActionLedger;
  activities: PlayerActivities;
  auth?: AuthenticatedAccount;
  cancelReconnect?: () => void;
  initialSpawn: InitialSpawn;
  transport: object;
  connectionPeriod: number;
  disconnectSnapshot?: PlayerPositionSnapshot;
  lastCapturedPosition?: Vec3;
}

export interface ClientAction {
  session: PlayerSession;
  requestId: number;
  code?: ErrorCode;
}
