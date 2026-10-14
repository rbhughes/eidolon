# eidolon / web

The browser version of [Eidolon](../README.md), live at
**[ghost.purr.io](https://ghost.purr.io)**. The CLI next door listens
through an RTL-SDR dongle; a web page can't reach a USB radio on a
stranger's desk, so this version hops nine live internet radio stations
instead.

Astro (`output: 'server'`) with the Cloudflare adapter, deployed as a
Worker. Two models through OpenRouter:
`mistralai/voxtral-mini-transcribe` for speech-to-text, chosen for latency
over Whisper-class models, and `openai/gpt-4o-mini` to translate the result
-- most of these stations aren't in English, and the transcription model
doesn't translate. Two display modes: *spooky*, which is just a seance, and
*skeptic*, which logs every step behind it.

## How it's served

Two Cloudflare projects, which is one more than it looks like it needs:

- **Worker `eidolon`** (`wrangler.jsonc`) -- the app itself. Deliberately
  `workers_dev: false`, so it has no public URL of its own.
- **Pages project `ghost-purr`** (`../ghost-pages/`) -- a thin proxy at
  ghost.purr.io that reaches the Worker over a service binding. Its
  `public/_worker.js` explains why it exists.

The two names must differ: locally, wrangler resolves the `EIDOLON` service
binding by name, and a shared name can bind the proxy to itself.

`compatibility_flags` includes `enable_request_signal`, without which
pressing stop mid-transcript aborted only the browser's fetch while the
server kept paying for the OpenRouter calls (verified: cancelled requests
still ran to a 200).

## Internet radio is not a radio

Retuning an SDR is nearly instant and the audio is live. An HTTP stream is
neither, and every hop paid for it:

- **Stay connected.** Icecast and StreamTheWorld send each new listener
  several seconds of pre-buffered audio so playback starts smoothly.
  Reconnecting on every hop replays that catch-up burst each time --
  measured, it inflated the audio to about 3.5x real time. The server now
  holds one connection per station open for the whole session and discards
  the first two seconds of each, so everything after that is live.
- **Multiplex.** Browsers allow six HTTP/1.1 connections per site, so nine
  open streams starved everything else, including the transcription
  request. `pages/api/stream.ts` merges all nine into one framed stream
  (`[station][length][bytes]`) that `lib/stationBuffer.ts` splits back
  apart, and disconnects any listener that stops reading rather than
  buffering for them.
- **Cut on frames.** Playing the live edge in small pieces failed: an MP3
  fragment decoded on its own starts in silence, and Firefox rejected 21 of
  48 of them outright, losing 46% of the audio. Each hop now takes a
  station's latest two seconds, cut on validated MP3 frame boundaries with
  three warm-up frames for the decoder, and schedules it to start the
  instant the previous snippet ends (`lib/mp3.ts`,
  `lib/snippetPlayer.ts`).
- **Transcribe what you heard.** The clip sent to OpenRouter is assembled
  from the exact bytes that were played, not fetched again, so the
  transcript cannot drift from what came out of your speakers.

`data/stations.ts` is a separate, smaller list from the CLI's
`streams.json`: every entry is confirmed `audio/mpeg`, so the capture
endpoint can forward raw bytes straight to OpenRouter with no transcoding.

## Cost and limits

Transcription is $0.003 per minute of audio; translation is $0.15 per
million input tokens and $0.60 per million output. A typical 30-second
transcript costs about $0.0015 to transcribe and $0.00005 to translate --
roughly 650 transcripts per dollar. Skeptic mode shows the exact token
counts and cost OpenRouter reports for each call rather than estimating
client-side.

`lib/rateLimiter.ts` caps each visitor at 10 transcriptions and 60 stream
connections per minute, using one Durable Object per client key so the
counts are exact (Cloudflare's native binding is per-location and
eventually consistent -- by its own docs, not an accounting system). It is
deliberately not a global limiter; the hard spending ceiling is the
OpenRouter key's own credit limit.

`lib/hedge.ts` sends one backup request if a call stalls past roughly 2.5x
the slowest of 20 measured normal calls, so a single hung OpenRouter
request doesn't cost you the transcript.

## Development

```sh
npm install
npm run dev        # `predev` regenerates worker-configuration.d.ts first
npm run build
npx astro check    # must stay at 0 errors
```

`OPENROUTER_API_KEY` is declared in `astro.config.mjs` as a server secret
and read via `getSecret()`. Locally it comes from a gitignored `.env`; in
production set it with `npx wrangler secret put OPENROUTER_API_KEY`.

See `CLAUDE.md` for the background dev-server convention and the
`worker-configuration.d.ts` / DOM-globals caveat behind using
`appendChild`/`insertBefore` in client code.

## Deploy

```sh
npm run build && npx wrangler deploy                   # the Worker
cd ../ghost-pages && ../web/node_modules/.bin/wrangler pages deploy
```
