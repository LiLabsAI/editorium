# Plan 13 — SaaS: Billing/Credits, Share Links, Rate Limits, Moderation

**Depends on:** Plans 7, 11 (the operations being metered) · **Screens:** C (Share button)

## Goal

Turn the app into a SaaS: credit-metered AI operations with plan limits, public share links for
images/albums, abuse controls, and content moderation on uploads and prompts.

## Credits & billing

- Template billing module (or stripe-style provider per template convention):
  - Plans: `Free` (N credits/mo), `Pro` (more + higher-resolution enhance), `Team` later.
  - **Credit costs table** (config): T2I generate = 1, region edit = 2, enhance-4K = 3,
    segmentation = free (it's the differentiator — never paywall recognition).
  - Ledger table `credit_events` (userId, delta, reason, jobId) — append-only; balance =
    materialized on user row, reconciled by ledger.
  - Enforcement middleware on every AI-enqueueing route: check balance → 402 with
    `insufficient_credits` code → UI upsell dialog (plan picker) — job enqueue and
    ledger debit must be atomic (D1 batch).
  - Monthly reset via Workflows scheduled trigger; usage page (`/settings/usage`) with
    per-operation breakdown.
- Guests/expired jobs refund on hard failure (ledger reversal keyed by jobId idempotency).

## Share (the top-bar Share pill)

- `POST /api/images/:id/share` → `share_links` row (id, imageId|albumId, expiresAt?, allowDownload)
  → public route `/s/:token` (no auth): dark viewer page — image, "Made with Editorium" badge,
  download button if allowed, CTA to sign up.
- Share dialog: copy link, expiry selector, download toggle, revoke.

## Rate limiting & abuse

- Per-user sliding window (D1 or Durable Object rate limiter) on: uploads (n/min),
  generations (n/min + daily), chat messages. 429 with `Retry-After`.
- Upload moderation: NSFW/image-safety check at registration (catalog check for a Workers AI
  classifier, else provider adapter) → reject + user-facing reason.
- Prompt moderation: classifier pass before T2I/inpaint; violations logged, repeat → flag.

## Acceptance

- Free plan user: 4th generation of the month blocks with upsell; ledger shows debits; failed job
  auto-refunds once (idempotent).
- Share link opens logged-out in incognito, respects expiry + download toggle, revoke kills it.
- Rate-limit + NSFW-reject paths tested (mocked classifiers); 429 surfaces friendly toast.
