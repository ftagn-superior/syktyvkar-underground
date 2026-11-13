import type { AreaResult, AvatarSkinId, ErrorCode, MoveInput, PrepareArea } from '@su/contracts';
import type { AuthenticatedAccount } from '../accounts/store.js';
import type { ActionLedger } from '../gameplay/action-ledger.js';
import type { PlayerActivities } from '../gameplay/player-activities.js';

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
}

export interface ClientAction {
  session: PlayerSession;
  requestId: number;
  code?: ErrorCode;
}
