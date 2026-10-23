// The pending-offer slot for an opened .tproject: cold launches land before the renderer subscribes.
let pendingOffer: string | null = null;
let broadcast: ((path: string) => void) | null = null;

export function setPackageOfferBroadcast(fn: (path: string) => void): void {
  broadcast = fn;
}

/** Read-and-clear: the offer is consumed exactly once. */
export function takePendingPackageOffer(): string | null {
  const offer = pendingOffer;
  pendingOffer = null;
  return offer;
}

/** Stores an offer in the pending slot and pushes it to any subscriber; the renderer imports it once unlocked. */
export function queueOffer(path: string): void {
  pendingOffer = path;
  broadcast?.(path);
}
