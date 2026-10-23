// The unlocked account's workspace identity, resolved from the local server into the one slot every consumer reads.
export interface Identity {
  userId: string;
  orgId: string;
  role: 'owner';
  displayName: string;
  email: string;
}

let cachedIdentity: Identity | undefined;

/** The single resolved identity for the whole app; set once the app unlocks. */
export function getIdentity(): Identity {
  if (!cachedIdentity) {
    throw new Error('getIdentity() called before the identity resolved');
  }
  return cachedIdentity;
}

/** Reads the workspace identity over the door and caches it into the one slot. */
export async function resolveIdentity(
  call: (channel: string, args: unknown[]) => Promise<unknown>,
): Promise<Identity> {
  const dto = await call('identity', []) as Partial<Identity> | null;
  if (dto === null || typeof dto !== 'object'
    || typeof dto.userId !== 'string' || typeof dto.orgId !== 'string'
    || typeof dto.displayName !== 'string' || typeof dto.email !== 'string') {
    throw new Error('the workspace door returned no usable identity');
  }
  const identity: Identity = {
    userId: dto.userId, orgId: dto.orgId, role: 'owner',
    displayName: dto.displayName, email: dto.email,
  };
  cachedIdentity = identity;
  identityResolve?.(identity);
  return identity;
}

/** Locking: no identity until the next unlock; getIdentity() then throws. */
export function clearIdentity(): void {
  cachedIdentity = undefined;
}

let identityResolve: ((identity: Identity) => void) | null = null;
const identityPromise = new Promise<Identity>((resolve) => { identityResolve = resolve; });

/** Resolves once the identity exists; request paths that race the unlock wait here. */
export function identityReady(): Promise<Identity> {
  return cachedIdentity !== undefined ? Promise.resolve(cachedIdentity) : identityPromise;
}
