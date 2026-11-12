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

Tabloom is a local app for the person holding the receipt. Paste the receipt, describe the evening in a sentence or two, check the proposed split, and send each guest a payment request for their exact share.

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
