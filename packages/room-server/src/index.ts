// Room-server library exports; nothing here listens on a port by itself.
export { applyRoomsLineage } from './lineage.js';
export { withTenant, parseAppHost, createHostResolver } from './tenancy.js';
export type { TenantContext, HostResolver } from './tenancy.js';
export { createPublishDoor, publishEnvelopeSchema } from './publish.js';
export type { PublishInput, PublishResult, PublisherIdentity, TokenVerifier } from './publish.js';
export { createRoomRouter } from './router.js';
export type { RoomRouter, RoomRequest } from './router.js';
export {
  SESSION_COOKIE, mintSessionCode, sessionCookieValue, sessionFromCookieHeader, verifySessionCode,
} from './session.js';
export type { AppSession } from './session.js';
export { serveAppPage, composeServedAppPage, NOT_HERE, PAUSED, BUSY } from './scene.js';
export type { RoomResponse, ChangedAction } from './scene.js';
export { createRoomLiveHub } from './live.js';
export type { RoomLiveHub } from './live.js';
export { roomSceneData, resolveReleaseScene, roomLiveTarget, roomServes } from './data.js';
export type { RoomFeedResult } from './data.js';
export { roomSceneProjection } from './projection.js';
export type { RoomProjectionResult } from './projection.js';
export { roomAction } from './actions.js';
export type { RoomActionResult, RoomActionAnnounce } from './actions.js';
export { AI_DOOR_PATH, AI_DOOR_REFUSAL, aiDoorSeam } from './aiDoor.js';
export type { AiDoorResponse } from './aiDoor.js';
export { PILL_CSS, PILL_JS, PILL_OPEN_HOVER_MS, PILL_SHRINK_MS, pillMountHtml } from './pill.js';
