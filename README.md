# voiceover-app

The downstream service for the script pipeline. It receives a finished script (hook + chapters) from the
`script-pipeline` skill, generates each segment with the 69labs voice, stitches them into one mp3 with natural-breathing
pauses, names the file after the video, and attaches it to the editor's Trello card. A small dashboard shows job status
and lets you play/download the audio or re-run a failed job.

Status: **works end-to-end today with a mock voice.** Drop in the real 69labs provider (one file) to go live.

## How it fits

```
script-pipeline skill ──POST /api/jobs──▶ voiceover-app
                                              │  1. 69labs: synthesize each segment
                                              │  2. ffmpeg: stitch with pauses → name file
                                              │  3. Trello: attach audio to the card id the skill sent
                                              ▼
                                          dashboard (status, playback, re-run)
```

The exact request/response shape is the contract in
`../script-pipeline/references/handoff-contract.md`. Build/keep the app matching it.

## Run locally

```bash
cp .env.example .env        # set API_KEY; TTS_PROVIDER=mock works with no accounts
npm install                 # needs ffmpeg on PATH (preinstalled on Render's Node env)
npm start                   # http://localhost:3000  → dashboard
npm run smoke               # end-to-end check with the mock voice
```

POST a job:
```bash
curl -X POST localhost:3000/api/jobs -H 'content-type: application/json' -H 'x-api-key: <API_KEY>' -d '{
  "channel_id":"british-documentaries","slug":"demo-2026-06","working_title":"Demo",
  "voice_id":"<voice>","pauses":{"after_hook":0.8,"between_chapters":0.6},"output_name":"Demo",
  "segments":[{"kind":"hook","index":0,"text":"..."},{"kind":"chapter","index":1,"text":"..."}],
  "trello_card_id":"<optional card id>"
}'
```

## Deploy (GitHub → Render)

1. Push this folder to a GitHub repo.
2. Render → **New → Blueprint** → pick the repo. `render.yaml` provisions the web service (Render's Node env includes
   ffmpeg) and a 1 GB disk for job data + audio.
3. In Render's dashboard set the secret env vars (`TRELLO_KEY`, `TRELLO_TOKEN`, and the `SIXTYNINELABS_*` group once
   wired). `API_KEY` is auto-generated — copy it into the skill's per-channel config / handoff auth.
4. Set `PUBLIC_BASE_URL` to the Render URL so audio links resolve.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET  | `/healthz` | none | health check |
| POST | `/api/jobs` | `x-api-key` | create a job (the skill's handoff) |
| GET  | `/api/jobs` | `x-api-key` | list jobs |
| GET  | `/api/jobs/:id` | `x-api-key` | job status |
| POST | `/api/jobs/:id/retry` | `x-api-key` | re-run a job |
| GET  | `/` | none | dashboard |
| GET  | `/audio/<file>` | none | stitched audio files |

## 69labs (wired)

`src/tts/sixtynineLabsProvider.js` is wired to the real API (`https://69labs.vip`). TTS is async/job-based, so per
segment it does `POST /api/v1/tts/generate` (or `/api/v1/voice-clones/generate` for a cloned voice) → poll
`GET /api/v1/tts/status/:jobId` until `COMPLETED` → `GET /api/v1/tts/download/:jobId`. It honours 429 `Retry-After` and
turns `FAILED`/`CENSORED` into clear errors (a `CENSORED` segment is flagged for a human rewrite, not auto-rewritten).

To go live: set `TTS_PROVIDER=sixtyninelabs`, `SIXTYNINELABS_API_KEY=vk_...`, and (optionally) the default voice/model
env vars. Per-job voice selection comes from the skill's channel config via the payload (`voice_id` + `voice_provider` +
`model`, or `voice_clone_id`). Verified with a stubbed-fetch test: `node scripts/provider-test.js`.

## Reliability

Every stage (each segment's synthesis, the stitch, the Trello attach) retries up to 3 times. If a stage still fails, the
job is marked `error` with the message — never silently dropped — and is visible + re-runnable on the dashboard.

## Notes / limits

- Single-process sequential queue and a JSON job store — right-sized for one person. If volume grows, swap the store for
  a database and the queue for a worker; the interfaces are small.
- The free Render plan sleeps when idle and its disk is wiped on redeploy of certain plan types — fine for transient
  audio, but treat Trello (and your own folders) as the source of truth for finished files, not this box.
