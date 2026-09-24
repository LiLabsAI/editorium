/** Product limits in one place (previously scattered literals). */

export const MB = 1024 * 1024;

/** Largest accepted upload / filter re-upload. */
export const MAX_UPLOAD_BYTES = 25 * MB;
/** Largest image sent inline to a Workers AI model; bigger inputs are
 * replaced by the ≤1600px web variant first (lib/operations.ts). */
export const MAX_MODEL_INPUT_BYTES = 6 * MB;
/** Longest side of the web / thumb derivatives. */
export const WEB_VARIANT_PX = 1600;
export const THUMB_VARIANT_PX = 512;
/** Longest side requested from the image-edit models. */
export const MODEL_EDIT_MAX_PX = 1024;

export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30;
export const SIGNED_IMAGE_URL_TTL_S = 600;

/** Exact D1 backstop for AI jobs per user per minute (lib/limits.ts). */
export const AI_JOBS_PER_MINUTE = 12;

export const MAX_PROMPT_CHARS = 500;
export const MAX_CHAT_CHARS = 2000;
export const MAX_POLYGON_POINTS = 200;

/** Client job polling: 2 minutes, then the UI says it is still running. */
export const JOB_POLL_TIMEOUT_MS = 120_000;
