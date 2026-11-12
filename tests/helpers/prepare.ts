import type { Room } from '@colyseus/sdk';
import type { PrepareArea, AreaResult } from '../../packages/contracts/src/index.js';

/** SDK fixtures exercise server preparation; only browser fixtures prove resource readiness. */
export function prepareSdk(room: Room<any>, automatic = true) {
  const plans: PrepareArea[] = [];
  const results: AreaResult[] = [];
  const ready = (plan = plans.at(-1)) => {
    if (plan)
      room.send('areaReady', {
        prepareId: plan.prepareId,
        layoutRevision: plan.layoutRevision,
        worldEpoch: plan.worldEpoch,
        mapVersion: plan.mapVersion,
      });
  };
  room.onMessage<PrepareArea>('prepareArea', (plan) => {
    plans.push(plan);
    if (automatic) ready(plan);
  });
  room.onMessage<AreaResult>('areaResult', (result) => results.push(result));
  room.send('requestArea');
  return { plans, results, ready };
}
