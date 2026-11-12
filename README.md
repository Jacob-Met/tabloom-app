# Tabloom

Split a shared bill by who actually had what, to the exact cent, then give each guest their own PayPal checkout.

## Try the simulated demo

```sh
npm install && npm run build   # once
npm run demo                   # or: node demo.mjs
```

Open <http://127.0.0.1:3000/tabloom/> (set `TABLOOM_PORT` to use another port). No PayPal keys, no local model and no network are needed; a "Simulated demo: no real PayPal call" badge stays in the corner.

1. Choose **New table** and **Create table**: the name and the four guests are already filled in.
2. Choose **Paste receipt text** (the example receipt is filled in), **Preview**, then **Use receipt**.
3. Open **Split from a note** (the example note is filled in) and choose **Suggest**: after a short pause each item gets a proposed set of guests. Check each item, confirm it, then apply and save.
4. Under **Guest shares**, press **Request payment** for Camille, follow **Open PayPal Sandbox** to the "Simulated PayPal approval" page and press **Approve**.
5. Back at the table, press **Complete approved payment**. Camille's $32.92 share is marked **Paid**.

What is simulated: the PayPal Sandbox calls (token, create order, get order, capture) are answered in-process by a small fake, and the AI answer is a fixed split for the example note. The real PayPal Sandbox and local-model setup is described below.

### From the group chat

Instead of typing a note, the payer can paste what everyone wrote in the group chat (the demo opens with a sample WhatsApp chat already filled in).

1. With the receipt imported, open **Paste the group chat** and press **Read the chat**. Plain `Name: message` lines, WhatsApp exports and iMessage/Android copies all work; timestamps, reactions, "image omitted" and system lines are ignored.
2. Tabloom matches each sender to a guest by first name (anyone it cannot match is highlighted so you can pick the guest or leave them out), then press **Suggest splits from the chat**. The chat becomes a note with each line attributed ("Camille said: I had the sea bass"), so every proposed item still shows the sentence it came from. You confirm each line exactly as before.
3. **Clear this up** appears under the senders before the AI runs and needs no model. If someone's line fits two receipt dishes ("the chicken" with a grilled chicken plate and a chicken penne on the bill), Tabloom asks which one with one-tap chips; a dish nobody mentioned asks who had it (with "split between everyone" as an option); a guest who never said what they had is flagged, but nothing is held up. One clear match (even with a typo, like "chkn" or "tagene") needs no card. Each answer is added to the note as a "Clarified by the payer" line, so the split and its source sentences use it; skipped cards stay as items that need a choice in the review.
4. **Where did you eat?** fills in from the receipt's first name line (or the table name) and **Paste the menu** takes menu text you copy yourself; nothing is looked up online. Dish names from the menu help match things like "the pollo" to the right receipt line, and a short "Menu context" block is added to the note after the chat lines.
5. After the payment requests exist, **Copy for the group chat** (under Guest shares) copies one tidy message with each guest's amount, their own PayPal link and a total check; each guest also has their own **Copy** button.

Tabloom is a local app for the person holding the receipt. Paste the receipt, describe the evening in a sentence or two, check the proposed split, and send each guest a payment request for their exact share.

## Record the table (voice intake)

Instead of typing a note, the payer can hold up the phone and ask everyone what they had. **Record the table** (or **Upload a recording**) sends the audio to a small local listener that transcribes it and separates the voices; the payer taps **Hear** on each speaker, picks the guest ("Who is this?", prefilled when someone says "I'm Camille"), and Tabloom builds a note such as "Camille said: I had..." for the same AI split and the same item-by-item confirmation. Audio never leaves your computer.

- Install once, then start: `npm run listen:install` (Python 3.10+ and ffmpeg; downloads about 600 MB of open models with no account) and `npm run listen` (port 5611, `TABLOOM_VOICE_PORT` to change).
- Without the listener the section says so and the typed note works as before. `npm run demo` includes a bundled sample recording with a canned result.
- Limits: overlapping speech is not separated, similar voices (or two same-sounding friends) can merge into one speaker, short replies and noisy rooms give weak voice prints, and speech recognition mangles unusual names. Always check the speaker list and the proposed split.

## How Tabloom decides who had what

Every clue becomes a claim: a person, an item and how much to trust the source. The payer's own answers count fully; the group chat and spoken lines count a lot, a typed note a bit less, where plates sit in a video frame less again, then what someone ordered here before.
When several clues point at the same person they add up, so two agreeing sources are surer than one.
When they point at different people the stronger one wins if it is clearly ahead, and Tabloom asks you only if they are close.
"Not mine" removes a person, "shared" splits the item, and a birthday covered by friends moves the cost to them.
Items with two or more on the receipt need that many different people, or Tabloom asks who had them.
Unmentioned drinks come as one question. Questions are ordered by price times doubt. The code is `tabloom/evidence.js`.

## Who it is for

Friends, housemates and colleagues who share meals and do not want to split evenly when the evening was not even: someone skipped the wine, two people shared the starters, it was somebody's birthday.

## How it uses AI

A local language model (served by [Ollama](https://ollama.com); only a loopback endpoint is accepted) reads the organizer's plain-language note, for example "Camille and Tomas shared the mezze, only Idris had the sea bass", and proposes who shared each receipt item.

- Every suggestion shows the part of the note it came from.
- A suggestion changes nothing. The organizer checks each item, corrects it and confirms every line before applying.
- The model never sees payment credentials and never moves money.

Built and tested with `qwen2.5:7b`.

## How it uses PayPal

Payments run on the PayPal REST API in **Sandbox**. The API origin is fixed to `api-m.sandbox.paypal.com`.

- **OAuth 2.0 client credentials** (`/v1/oauth2/token`), held by the local server only
- **Orders v2, create order** for one guest's exact share
- The guest approves on PayPal's own page
- **Orders v2, capture payment** once the guest has approved
- **Orders v2, show order details** to reconcile when a response was lost or unclear

A share is marked paid only when PayPal reports the capture. A capture is never retried with a new request ID. Creating the first payment request locks the bill, so an amount a guest approved cannot change under them.

## The arithmetic

Shares are calculated in integer cents. Tax, tip and discounts follow each person's food in proportion, with deterministic largest-remainder rounding, so the shares always add up to the receipt total.

## Run it

Requires Node.js 20 or newer.

```sh
npm install
npm run build
npm start
# open http://127.0.0.1:3000/tabloom/
```

That is enough to split a bill by hand. To add the local model and PayPal Sandbox:

```sh
ollama pull qwen2.5:7b

export TABLOOM_AI_URL="http://127.0.0.1:11434/api/chat"
export TABLOOM_AI_MODEL="qwen2.5:7b"
export TABLOOM_PAYPAL_CLIENT_ID="your sandbox client id"
export TABLOOM_PAYPAL_CLIENT_SECRET="your sandbox client secret"

npm start
```

Create Sandbox credentials at <https://developer.paypal.com/dashboard/applications/sandbox>. Guests pay with a Sandbox personal account or PayPal's Sandbox test cards.

Other settings: `TABLOOM_PORT` (default 3000), `TABLOOM_DATA_PATH` (where tables are saved; default `~/.local/share/tabloom/tabloom.json`), `TABLOOM_GUEST_URL` (a private-network address to share invitation links with guests on the same network).

## A two-minute walkthrough

1. **Start your table**: name it and list the guests.
2. **Import receipt**: paste the receipt text, review the items, tax and tip, and use it.
3. Open **Split from a note**, describe who had what, and choose **Suggest splits**.
4. Check each item, fix anything the model got wrong, tick each confirmation, apply and save.
5. In **Guest shares**, choose **Request payment** for a guest and open the PayPal Sandbox link to pay as that guest.
6. Back in Tabloom, **Complete approved payment**. The share shows as paid.

Receipt photos can also be read on the device (Tesseract OCR, bundled at build time; nothing is uploaded).

## Tests

```sh
npm test
```

The guest-network tests need a private network interface and the photo-reader process tests need the optional local vision runner; they fail without them. Everything else runs anywhere.

## Privacy

Tables, revisions and payment history are saved in one local JSON file. Credentials stay in the server's environment. The organizer app binds to loopback only.

## License

MIT. See [LICENSE](LICENSE). Bundled OCR components are Apache-2.0; their notices are copied beside them at build time.
