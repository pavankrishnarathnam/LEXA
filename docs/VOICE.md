# Voice: using LEXA completely by speaking

Everything in LEXA can be done by voice: ask for things, move around, hear what is on screen, click, fill in forms,
answer dialogs, and approve or reject the actions your agents want to take. Typing, the mouse and screen readers
keep working exactly as before; voice is an additional way in, not a separate mode of the app.

> **One thing voice cannot do:** sign in. The microphone is only available to a signed-in session (speech
> recognition is a paid API call made on your behalf), so the first sign-in is typed, pasted from a password
> manager, or entered with your operating system's own voice control. After that your session persists.

## Turn it on

| How | |
|---|---|
| **Alt + V** (or Ctrl + Alt + V) | From anywhere in the app. Press again to turn it off. |
| The **Voice** button in the header, the microphone in the chat box, or the big orb on the Command Center | |
| Command menu (**Ctrl/⌘ + K**) → *Turn voice mode on* | |
| First *Tab* stop on every page: “Turn voice control on” | For keyboard and screen-reader users |
| Settings → Voice → *Start voice automatically* | Starts with your first key press or click after opening LEXA (browsers do not allow a microphone to open sooner) |

The browser asks for microphone permission the first time. If you said no by accident: click the padlock (or
camera/microphone icon) in the address bar, allow the microphone for this site, and turn voice on again. LEXA says
this out loud too.

### No OpenAI credits? Voice still works, for free (Chrome, Edge, Safari)

Speech recognition has two engines, and LEXA picks one for you (Settings → Voice → *Speech recognition*):

| Engine | Cost | Where | Where your audio goes |
|---|---|---|---|
| **OpenAI** (`gpt-4o-mini-transcribe`) | about $0.003 per minute of speech | every browser, including **Firefox** | OpenAI |
| **Your browser's own** (Web Speech API) | **free** | **Chrome, Edge, Safari. Not Firefox.** | the browser vendor's speech service (Google in Chrome, Microsoft in Edge, Apple in Safari) |

*Automatic* (the default) uses OpenAI and **switches to the browser's recogniser by itself** the moment OpenAI cannot be
used: no API key, an empty balance ("You have no credits remaining", HTTP 429 `insufficient_quota`), a rejected key,
or your monthly AI budget used up. LEXA tells you out loud why it switched and carries on. If OpenAI failed it is not
tried again for ten minutes, so the next voice session starts on the browser's engine straight away.

If **neither** engine is available (for example Firefox with an empty OpenAI balance), voice mode stays open in a
**text-only** state: it says exactly why and what to do (add credits, or open LEXA in Chrome or Edge), and you can keep
typing the same commands in the bar while LEXA answers out loud.

The OpenAI API is billed separately from a ChatGPT subscription: a ChatGPT Plus plan does **not** include API credit.
Credits are bought at <https://platform.openai.com/settings/organization/billing>. Everything that needs an AI model
(planning, agents, answers) needs credit; voice *commands* that only operate LEXA (navigate, read, click, fill, approve)
do not.

A bar appears at the bottom of the screen showing what LEXA is doing (*Listening*, *Hearing you*, *Understanding*,
*Working on it*, *Speaking*, *Sleeping*), what it heard, what it said, and a box to **type** the same commands. Press
**Esc** at any time, or say “stop”, to silence LEXA.

## What you can say

You never have to memorise anything: say **“help”** and LEXA reads the list, or open the help dialog from the bar.
Wake word is optional: starting a sentence with “Hey LEXA” always works.

| Say | What happens |
|---|---|
| *“Find five remote backend jobs and score them”*, *“Draft a reply to Priya”*, any request | Sent to LEXA CORE, which plans and delegates as usual. It answers in short spoken sentences and reads the result when the task finishes. |
| “Go to tasks”, “open settings”, “show approvals”, “open voice settings”, “go back”, “new conversation” | Navigation, instantly and for free (no AI call). |
| “What's pending?”, “catch me up” | Active tasks, approvals waiting, unread notifications, next calendar event, budget warnings. |
| “Read my notifications”, “read the page”, “where am I?”, “what can I click?” | Reads the screen to you. “Read more” continues a long text; “repeat that” says it again. |
| “Click create agent”, “press save”, “open Travel Planner” | Operates any button, link, tab or menu item **by its name**. If several match, LEXA lists them and you say a number. |
| “Set name to Travel Planner”, “set range to last 30 days”, “turn on auto memory”, “type buy milk”, “submit” | Fills fields, picks options, flips switches, dictates into the focused field, submits the form. |
| “Scroll down”, “go to the bottom”, “close”, “focus on the message box” | Moves around the page. |
| “Speak slower”, “speak faster” | Changes LEXA's speaking speed (saved). |
| “Stop” | Interrupts LEXA immediately. |
| “Go to sleep” → “Hey LEXA” | Pauses listening until you say the wake phrase. LEXA also falls asleep after five quiet minutes. |
| “Stop listening” | Turns voice mode off and releases the microphone. |

Things that merely *look* like commands but are really requests still go to LEXA: “open a new email to Alex”,
“push my changes to GitHub”, “set a reminder for 5 pm to call mom”, “turn off the lights” are only treated as clicks
or form fills if a control with that name actually exists on the page.

### Approvals: spoken, but never careless

When an agent wants to do something outside LEXA (send an email, create an automation, open a pull request…) LEXA
reads you the approval **in full**: who wants to do what, the exact content, and the risk. Then you say
**“approve”**, **“reject”** or **“skip”**.

* You can only approve by voice **after LEXA has finished reading it**. If you say “approve” early, it tells you it
  has not finished and approves nothing. (Say “read it again”.)
* **High-risk** actions (payments, transfers, contracts, confidential sends, irreversible deletions) need you to
  say “approve” **twice**; a casual “yes” is not enough.
* Only an explicit **“reject”**, “no” or “decline” rejects. **“Never mind”, “cancel”, “forget it”** leave the approval
  pending and do nothing. A casual “ok”, “sure” or “thanks” never approves anything.
* Words picked up **while LEXA is talking** can interrupt it but can never approve, confirm, click or type: they
  might be its own voice coming back through your speakers.
* The on-screen *Approve & run* button, clicked by voice (“click approve”), follows the same rules.
* Approved actions run with exactly the parameters you heard and saw; nothing about the permission system changes.
  Typed commands in the bar are exempt from the read-first rule (the text is on screen).

Other safety rules: **destructive controls** (delete, disconnect, reset, sign out…) need a spoken “yes”; **password and
key fields are never dictated** (the sentence would be sent to speech recognition) or read back; confirmation
dialogs are real dialogs that read their own question aloud and answer to “yes” / “no”.

## For screen-reader and keyboard users

* Voice never replaces the page: everything it does is also visible in the DOM and reachable by keyboard.
* Voice only uses the **accessible name** of controls, so labelling a control properly improves screen readers,
  voice control and the audit at once. The automated audit (below) enforces this.
* The bar is a labelled *region*; its transcript is a `log`; notices use `status`, errors `alert`. The phase text is
  deliberately not a live region, so a screen reader is not interrupted by “Listening / Hearing you” changes.
* **Text-only voice mode**: if speech recognition is unavailable (no `OPENAI_API_KEY`), voice mode still starts,
  says why, and you can type the same commands in the bar while LEXA speaks its answers.
* The native `confirm()` / `prompt()` dialogs were replaced by accessible dialogs.

## How it works

```
microphone ──► AudioWorklet (frames) ──► voice-activity detector ──► 16 kHz mono WAV (one sentence)
                                                                              │ POST /api/voice/transcribe
                                                                              ▼
                                       OpenAI gpt-4o-mini-transcribe (fallback whisper-1)
                              (or, free: the browser's own recogniser, no upload) │ text
                                   ┌── command grammar (local, instant, free) ◄┘
                                   │        navigate · read · click · fill · approve · status …
                                   └── otherwise ► LEXA CORE (voice flag → short spoken-style replies)
                                                                              │ result
speaker ◄── audio ◄── POST /api/voice/speak (gpt-4o-mini-tts, fallback tts-1) ◄┘  or browser speechSynthesis
```

* **Half-duplex with barge-in.** LEXA's own voice is filtered out (echo cancellation requested from the browser,
  a raised detection threshold while it speaks, and text matching for speech that overlapped it). You can interrupt
  it; you cannot confirm anything while it is talking.
* **Patience** (Settings → Voice) decides how long LEXA waits after you stop speaking: 0.6 / 1 / 1.8 seconds.
* **Why two engines:** Firefox has no browser speech recognition, so OpenAI is the only option there; in Chrome, Edge and
  Safari the browser's own recogniser is free but streams audio to the browser vendor. Automatic mode uses OpenAI (the
  service LEXA already talks to) and falls back to the browser's; *OpenAI only* and *Browser only* are available if you
  want to decide where your voice goes.
* **No always-on microphone.** The mic is only open while voice mode is on. In *sleep* it keeps listening for the wake
  phrase, which means short clips are still sent for transcription; turn voice off to stop that completely.
* Audio is **never stored** by LEXA (it is transcribed and discarded; only the text and token usage are kept).

### Cost (estimates, check OpenAI's current prices)

Only finished sentences are uploaded, so you pay for the seconds you actually speak: about **$0.003 per minute** of
your speech (transcription) and about **$0.015 per minute** of LEXA speaking with the OpenAI voice. The *browser voice*
(Settings → Voice → Voice engine) and the browser's recogniser are free. Usage is recorded in Settings → Usage & cost as `stt` / `tts`
and counts toward your monthly budget; when the budget is reached voice says so instead of failing silently.
Limits: 40 transcriptions and 90 spoken chunks per minute per user.

## Configuration

Environment (server): `OPENAI_API_KEY` (required for speech recognition and the OpenAI voice), and optionally
`STT_MODEL`, `STT_FALLBACK_MODEL`, `TTS_MODEL`, `TTS_FALLBACK_MODEL`, `VOICE_STT_PER_MINUTE` (see `.env.example`).
If your account lacks the primary model, the fallback is used automatically.

Per user (Settings → Voice, stored in your profile settings): speak responses aloud, voice engine, voice, speed,
speech recognition (automatic / OpenAI only / browser only), language (auto-detect by default), patience, require
“Hey LEXA”, sound cues, start automatically.

## Troubleshooting

| Symptom | Fix |
|---|---|
| “Microphone access is blocked” | Allow the microphone for this site (padlock icon in the address bar), then turn voice on again. Voice needs HTTPS, which GitHub Codespaces and the production setup provide. |
| “Your OpenAI account has no credits left” / HTTP 429 `insufficient_quota` | The key is valid but the account balance is empty. Add credits (billing link above). Until then LEXA uses the browser's free recogniser if your browser has one (Chrome, Edge, Safari) and tells you if it does not (Firefox). |
| Voice bar says “Voice (text only)” | Neither engine is available: the server has no `OPENAI_API_KEY` or no credits **and** the browser has no recogniser (Firefox). Open LEXA in Chrome or Edge, or fix the key / balance, or keep typing commands. |
| “The browser's speech service could not be reached” | Chrome and Edge send audio to their vendor's service: it needs an internet connection. Switch to *OpenAI only* in Settings → Voice if that is blocked on your network. |
| LEXA's replies are silent | Your browser blocked sound: press any key or click once. Or switch to the *browser voice* in Settings → Voice. |
| It keeps hearing things in a noisy room | Turn on *Require “Hey LEXA”*, use *Patient*, or wear a headset (this also stops echo). |
| LEXA talks over itself or answers its own words | Use headphones. Speakers that are loud or near the microphone defeat echo cancellation. |
| Alt+V opens a browser menu | Use **Ctrl + Alt + V**, the header button, or the first *Tab* stop. |
| “Too much speech at once” | The 40-per-minute limit was reached. Pause a moment. |

## Verification status (what has and has not been tested)

Tested, from the final commit:

* **Unit tests** (`frontend/tests/voice`, 182 tests): command grammar including negative cases and everything LEXA
  tells you to say; operating real Radix components (tabs, dialog, dropdown, switch) through accessible names;
  the controller's safety rules with a fake microphone, speaker and API (read-before-approve, high-risk double confirm,
  “never mind” never rejects, nothing confirmable while LEXA talks, echo and hallucination filtering, wake and sleep,
  destructive confirmation, password fields, notifications and task results); audio encoding and the detector.
* **Backend tests** (`backend/tests/test_voice.py` and `test_provider_errors.py`, 24 tests): transcription and speech endpoints against the
  OpenAI SDK's own error types, model fallback, rate limits, budget, usage accounting, validation; an empty OpenAI balance
  is classified as non-retryable, skipped by the model fallback chain, answered as HTTP 402 with a code, and makes a task
  fail at once with the reason.
* **Browser end-to-end** (Chromium, `tests/e2e/voice.spec.ts`, 12 tests) with a **fake microphone playing a
  synthetic speech-like recording**: the real worklet, detector, upload and playback run. A spoken sentence
  navigates the app; a spoken “approve” approves only after the approval was read; “never mind” leaves it pending;
  forms are filled and submitted by command; the app's confirmation dialog is answered by spoken yes/no; requests
  spoken on any page are answered and read back; no key plus a browser without a recogniser gives text-only mode; an empty OpenAI balance makes LEXA switch to the
  browser's recogniser (a *fake* `SpeechRecognition` stands in for Chrome's) and keep working; the recogniser can be chosen
  in Settings by voice.
* **Accessibility audit** (`tests/e2e/a11y.spec.ts`, axe-core 4.14, WCAG 2.1 A and AA): 20 screens in dark **and** light
  themes, plus the voice bar, the conversation view, every dialog and the sign-in pages: **0 violations**. (It found and
  we fixed low-contrast text, an unnamed progress bar, mislabelled buttons and status dots without roles.)

**Not tested here — please check on your side:**

* **Real speech.** The end-to-end suite replaces OpenAI's transcription with a stub that returns the text the test
  queued, and Chrome's recogniser with a fake, so recognition *accuracy* (accents, noise, names), OpenAI's actual voices
  and latency, and Chrome's / Edge's real `SpeechRecognition` behaviour are unverified. The OpenAI calls are tested only
  against a mocked client.
* **Firefox and Safari.** Everything was run in Chromium. The code uses standard APIs (`getUserMedia`, AudioWorklet
  with a script-processor fallback, Web Audio, `speechSynthesis`) that Firefox supports, but it has not been run in Firefox.
* **Real screen readers** (NVDA, JAWS, VoiceOver, Orca). Axe finds only the problems a machine can find (roughly a
  third of WCAG); the structure is sound but a person using a screen reader should try it.
* Phones and tablets (the layout was verified at phone width; microphone behaviour there was not).
* Long sessions, very noisy rooms and multiple people talking.

## Limits by design

* No voice sign-in (see the top of this page); the file picker for attachments cannot be opened by voice (browsers
  require a physical gesture), though dictation and everything after it can.
* Voice works while a LEXA tab is open. A browser cannot listen for a wake word with the tab closed; that would need a
  separate desktop or phone companion (not included).
* Spoken replies are shortened: LEXA says the head of a long answer and offers “read more”. The full text is always on
  screen.
