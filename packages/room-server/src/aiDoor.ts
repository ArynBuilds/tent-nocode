// Reserved AI route for hosted apps: refuses until the caller brings their own key.

export const AI_DOOR_PATH = '/api/ai';

/** Nodeloom never supplies the inference key; callers bring their own. */
export const AI_DOOR_REFUSAL = "This app's assistant needs a key — connect yours.";

export interface AiDoorResponse { status: number; body: string }

export function aiDoorSeam(): AiDoorResponse {
  return { status: 501, body: JSON.stringify({ ok: false, reason: AI_DOOR_REFUSAL }) };
}
