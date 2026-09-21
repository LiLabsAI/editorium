# Plan 6 — Chat Agent: Streaming, Tool-Calling, Intent→Operation

**Depends on:** Plan 5 · **Screens:** B (the conversation)

## Goal

Make "Ask Editorium" real. The reference conversation shows the pattern: user says in casual
prose what they want ("this is low quality — make it 4k, like an expensive camera shot it"), the
assistant briefly narrates a plan, then delivers the result image inline with a short summary.
We implement an LLM agent with **tool-calling** whose tools are the product's operations.

## Backend

- `POST /api/threads/:id/messages` — body: text + attachments + mentions.
  - Persist user message; create assistant message row; respond as **SSE stream**
    (Hono `streamSSE`): events `token` (text deltas), `tool` (name/args/status),
    `result` (imageId/versionId/jobId), `done`.
  - Model: Workers AI instruct LLM (candidate: `llama-3.3-70b-instruct` fast variant or 8B for
    cost — verify catalog), temperature ~0.4, system prompt = Editorium assistant persona with
    operation catalog + image context (labels, dimensions, segment summaries when ready).
- **Tools the model may call** (each enqueues a job and returns a jobId the stream reports):
  - `generate_image(prompt, aspect)` → plan 7
  - `enhance_image(imageId, strength)` → plan 11 (upscale/detail)
  - `edit_region(imageId, segmentId, prompt)` → plan 11 (inpaint)
  - `describe_image(imageId)` → VLM caption (Workers AI vision model)
  - `list_album_images(filter)` → context lookup
- **Intent examples baked into system prompt:** quality/4K/camera → enhance; "add/remove/make X
  like Y" on a selected/mentioned image → edit_region or generate; greetings/questions → answer.
- Consumers of tool jobs update `chat_messages.resultImageId` when done; client listens via the
  open SSE plus job polling fallback (`GET /api/jobs/:id`).

## Frontend

- `useChatStream(threadId)` hook: optimistic user bubble, streaming assistant text with
  markdown-lite rendering, inline result thumbnail card when `result` event arrives, error state
  with retry.
- `Chat ⌄` dropdown: thread list + "New chat".
- Assistant messages keep plain-paragraph styling per Screen B (no bubble chrome).

## Acceptance

- Seeded conversation reproduces the reference shape: user bubble with the quality request →
  streamed assistant narration → inline thumbnail of result (using plan 7 stub) → closing line.
- Tool events surface as subtle inline status ("Enhancing image…") then resolve.
- SSE survives Worker streaming limits (no buffering); fallback polling completes the UI if the
  stream drops mid-run (resume-on-reload renders persisted messages).
- Unit tests for intent router (prompt → expected tool+args) across 10 cases.
