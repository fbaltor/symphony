/**
 * Webhook receiver barrel — phase 2.6 of the 16-state pipeline.
 *
 * Exports the Linear webhook handler so `main.ts` can wire it into the
 * existing HTTP server alongside `/health`, `/status`, `/cost`, `/admin/*`.
 */

export {
  type LinearWebhookContext,
  FRESHNESS_WINDOW_MS,
  MAX_BODY_BYTES,
  MAX_SIGNATURE_LENGTH,
  handleLinearWebhook,
  isWebhookPath,
  verifyHmac,
} from "./linear-receiver.js";
