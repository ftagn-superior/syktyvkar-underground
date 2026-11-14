import type { Room } from '@colyseus/sdk';
import type { PrepareArea, AreaResult, LayoutChanged } from '../../packages/contracts/src/index.js';

/** SDK fixtures exercise server preparation; only browser fixtures prove resource readiness. */
export function prepareSdk(room: Room<any>, automatic = true) {
  const plans: PrepareArea[] = [];
  const results: AreaResult[] = [];
  const changes: LayoutChanged[] = [];
  const ready = (plan = plans.at(-1)) => {
    if (plan)
      room.send('areaReady', {
        prepareId: plan.prepareId,
        layoutRevision: plan.layoutRevision,
        worldEpoch: plan.worldEpoch,
        mapVersion: plan.mapVersion,
      });
  };
  const applied = (change = changes.at(-1)) => {
    if (!change) return;
    const { worldEpoch, layoutRevision, mapVersion } = change.publication;
    room.send('layoutApplied', { worldEpoch, layoutRevision, mapVersion });
  };
  const applyWhenReady = () => {
    const change = changes.at(-1);
    if (!change) return;
    const plan = [...plans]
      .reverse()
      .find((plan) => plan.layoutRevision === change.publication.layoutRevision);
    if (plan && !results.some((result) => result.prepareId === plan.prepareId && result.ok)) return;
    applied(change);
  };
  room.onMessage<PrepareArea>('prepareArea', (plan) => {
    plans.push(plan);
    if (automatic) ready(plan);
  });
  room.onMessage<AreaResult>('areaResult', (result) => {
    results.push(result);
    if (automatic && result.ok) applyWhenReady();
  });
  room.onMessage<LayoutChanged>('layoutChanged', (change) => {
    changes.push(change);
    // The local prepareArea, when required, follows the publication notification.
    if (automatic) setTimeout(applyWhenReady, 0);
  });
  room.send('requestArea');
  return { plans, results, changes, ready, applied };
}
