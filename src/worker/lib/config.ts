/** Product limits and shared constants in one place. */

export const MB = 1024 * 1024;

/** Largest accepted upload / filter re-upload (aligned with Cloudflare Images' 20 MB limit). */
export const MAX_UPLOAD_BYTES = 20 * MB;
export const IMAGES_INPUT_MAX_BYTES = 20 * MB;

/** Largest image sent inline to a Workers AI model; bigger inputs are
 * normalized down first (lib/operations.ts). */
export const MAX_MODEL_INPUT_BYTES = 6 * MB;

/** Longest side of the working copy / variants / model inputs. */
export const WORKING_MAX_PX = 4096;
export const WEB_VARIANT_PX = 1600;
export const THUMB_VARIANT_PX = 512;
export const MODEL_EDIT_MAX_PX = 1024;
export const MAX_MASK_PX = 1024;

export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30;
export const SIGNED_IMAGE_URL_TTL_S = 600;

/** Exact D1 backstop for AI usage per user per minute (lib/limits.ts). */
export const AI_JOBS_PER_MINUTE = 12;
export const AI_CALLS_PER_MINUTE = 30;

export const MAX_PROMPT_CHARS = 500;
export const MAX_CHAT_CHARS = 2000;
export const MAX_POLYGON_POINTS = 200;
export const MAX_BATCH_INSTRUCTIONS = 5;
export const MAX_HISTORY_MESSAGES = 10;
export const MAX_JSON_BODY_BYTES = 512 * 1024;

export const DEFAULT_USER_CREDITS = 20;

/** Client job polling fallback interval & timeout. */
export const JOB_POLL_TIMEOUT_MS = 120_000;
