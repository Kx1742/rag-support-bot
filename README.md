# RAG Support Bot + Shop Desk

[![CI](https://github.com/Kx1742/rag-support-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/Kx1742/rag-support-bot/actions/workflows/ci.yml)

A customer-support chatbot for small businesses that **answers questions from the business's own
documents** and **books tables by chatting**, plus a **staff desk** with a till (POS), a kitchen
order queue, a bookings list and menu controls, all updating live.

- **Customers** chat on the website: "Do you have oat milk?", "Table for 4 on Saturday at 10?"
- **The AI** (Google Gemini) answers from the café's documents with citations, and checks availability
  and makes bookings through function calling, using the shop's real booking rules
- **Staff** see new bookings appear instantly on the desk, ring up orders with drink options,
  take cash or card payment, and move orders through New → Preparing → Ready
- **Managers** also refund orders, see the end-of-day sales report, and manage staff accounts

It's multi-tenant: each business is a folder with its own documents, menu, tables and opening hours.

> The demo business, **Bean & Byte Café**, is fictional. Its documents and menu are made up for this project.

**Live demo:** _coming soon_ <!-- TODO: paste the Render URL here after deploying -->
In the demo, open the staff desk and tap **Try as Barista** or **Try as Manager**. The data resets every night.

## Screenshots

| Kitchen display | Till with a loyalty reward |
|---|---|
| ![Kitchen display: orders by stage with waiting timers, paid/unpaid labels and an online pickup order](docs/screenshots/desk-kitchen.png) | ![Till: drink options, a loyalty member using a free-drink reward, and the charge button](docs/screenshots/desk-till.png) |

| Bookings and live table map | End-of-day report (managers) |
|---|---|
| ![Bookings: table map showing seated, reserved and free tables, plus arriving and seated bookings](docs/screenshots/desk-bookings.png) | ![Report: paid sales, cash vs card, unpaid, refunds, best sellers and sales by hour](docs/screenshots/desk-report.png) |

| Customer chat: order ahead | Pickup screen | Phone |
|---|---|---|
| ![Chat with the order-ahead card: menu, drink options, cart and pickup time](docs/screenshots/chat-order-ahead.png) | ![Pickup screen with order numbers preparing and ready to collect](docs/screenshots/pickup-screen.png) | ![The chat on a phone with the table booking form](docs/screenshots/phone-chat.png) |

<sub>Captured from the public demo with `npm run screenshots`, which drives a headless Edge/Chrome, so they're easy to refresh after design changes.</sub>

## Features

**Customer chat** (`/`)
- Grounded answers with clickable citations, streamed over Server-Sent Events
- **Books and cancels tables in conversation** (Gemini function calling), always confirming first
- "Book a table" form in the chat, which also works without AI
- **Order ahead**: pick items and drink options, choose a pickup time, pay at the counter; the order
  appears on the kitchen screen and the pickup screen
- **My booking**: look up or cancel your own booking with its reference + phone number
- **My points**: check a loyalty balance and rewards by phone number
- **Knows what's sold out**: with Gemini it reads the live menu (prices, sold out, "only 3 left");
  offline it adds a "Heads up: … is sold out today" notice

**Pickup screen** (`/display`, for a TV at the counter)
- Big "Preparing" and "Ready to collect" order numbers, updated live, newest call first, with a chime
- Shows order numbers only: no names or items
- Follow-up questions, suggested questions, business branding, dark mode, works on phones

**Staff desk** (`/desk`, each person logs in with their own username + PIN)
- **Till / POS**: menu grid by category, item search, **drink options** (size, milk, extra shot, iced...)
  with per-item notes, takeaway or dine-in by table
- **Payments**: cash with quick amounts and change due, or card confirmed from the card machine;
  pay now or keep a table's order open and pay later
- **Order queue**: New → Preparing → Ready → Picked up, with waiting timers, paid/unpaid labels
  and who rang each order up
- **Bookings**: day view, seat, finish, no-show and cancel, plus phone and walk-in bookings with table choice
- **Menu**: sold-out switch, **stock counts** (the till counts down, sells out at 0, can't oversell, and
  stock comes back on cancel/refund); managers **add items, change prices and options, hide items**.
  Desk edits survive changes to `shop.json`
- **Live updates**: new bookings (on any date) and orders appear on every open desk screen instantly
- **Loyalty ("Byte Points")**: look up or join members by phone at the till, earn 1 point per $1 paid,
  redeem rewards (free pastry 50, free drink 100, breakfast combo 250); the reward makes the most
  expensive matching item free; points come back on cancel/refund and expire after 12 months idle
- **Online orders** show on the kitchen screen with an Online label, pickup time and tap-to-call phone
- **Refunds** (managers): with a reason; paid orders can't simply be cancelled
- **End-of-day report** (managers): sales, cash vs card, unpaid, refunds, best sellers, sales by hour, CSV export
- **Staff accounts** (managers): add people, change roles, reset PINs, deactivate

**Engineering**
- Zero runtime dependencies: Node's built-in `node:http`, `node:sqlite` and `fetch`
- Booking rules enforced server-side: opening hours, slot grid, notice period, table sizes,
  overlap checks, per-phone limits
- Prices and option surcharges always come from the server, never from the browser
- Duplicate-order protection: each till order carries an idempotency key, so a network retry can't charge twice
- Rate limiting, a daily AI message cap, strict Content-Security-Policy, no `innerHTML`
- Production basics: health check that tests the database, HSTS on HTTPS, a request id on every
  response (shown to visitors on errors), request logs that never include query strings
- 140 tests, all offline: fake AI, in-memory SQLite, real HTTP server on a random port

## How it works

```mermaid
flowchart LR
    C[Customer chat page]
    D[Staff desk: till, orders, bookings, menu]
    subgraph Server["Node server"]
        API[HTTP API + rate limits]
        A[Assistant]
        R[RAG: chunk, embed, search]
        T[Booking tools]
        S[(Shop: SQLite per business)]
        E[Live events]
    end
    G[Gemini API]

    C -->|chat over SSE, booking form| API
    D -->|login cookie| API
    API --> A
    API --> S
    A --> R
    A <-->|function calling| G
    A --> T --> S
    S --> E -->|SSE| D
```

### Answering questions (RAG)
1. Documents are split by Markdown heading into chunks, embedded with `gemini-embedding-001`, and saved.
2. Each question is searched on its own **and** with the previous question (for follow-ups),
   keeping each chunk's best score.
3. Gemini answers using only the numbered sources and cites them. With no relevant sources
   and no tools, the bot gives the contact details instead of guessing.

### Booking by chat (function calling)
1. The system prompt gives Gemini today's date, a 14-day calendar (models are bad at date maths)
   and the booking rules.
2. Gemini calls `check_availability`. Our code runs the real rules and returns free times or the
   closest alternatives.
3. Gemini summarises the details and asks the customer to confirm. Only after a clear "yes" does
   it call `create_booking`.
4. The chat shows a confirmation card with the reference, and the desk announces the new booking live.

Rule violations ("we seat up to 6") are returned to the model as tool results so it can explain
them. Unexpected errors are not.

## Roles and permissions

| | Customer | Staff | Manager |
|---|:-:|:-:|:-:|
| Chat, book a table, order ahead, look up own booking or points (public site) | ✓ | ✓ | ✓ |
| Ring up orders, take payments, move orders along | – | ✓ | ✓ |
| Create, seat and cancel bookings; mark items sold out; set stock counts | – | ✓ | ✓ |
| Add menu items, change prices and options, hide items | – | – | ✓ |
| Cancel **unpaid** orders; look up / add loyalty members and redeem rewards | – | ✓ | ✓ |
| Refund paid orders | – | – | ✓ |
| See sales totals and the end-of-day report | – | – | ✓ |
| Add staff, change roles, reset PINs | – | – | ✓ |

- Customers never log in. They prove a booking is theirs with its reference **and** phone number.
- Staff and managers log in at `/desk` with their own **username + PIN** (hashed with scrypt).
  After 5 wrong PINs an account locks for 5 minutes.
- The owner logs in with username `owner` and the `STAFF_PASSWORD` from `.env` (always a manager),
  and uses it to create everyone else's accounts.
- Permissions are checked **on the server on every request** (`src/server/permissions.ts`); the desk only
  hides buttons people can't use. Role changes and deactivation take effect immediately, and a PIN reset
  or deactivation signs that person out everywhere.
- Every order records who rang it up, who took payment and who refunded it.

## Design decisions

| Decision | Why |
|---|---|
| Channel-independent `Assistant` with pluggable tools | Web chat today, WhatsApp next, same brain. |
| `node:sqlite`, one database file per business | Real transactions with zero dependencies, and tenants can't see each other's data. |
| Times stored as shop wall-clock values (`2026-11-14`, minute 600) | Only "now" needs a timezone conversion, which avoids most daylight-saving bugs. |
| Smallest free table that fits | Keeps big tables free for big groups. |
| Customer cancel needs reference **and** phone, same error for both | References can't be guessed or probed. |
| HttpOnly + SameSite=Strict session cookie, JSON-only writes | Blocks cross-site request forgery without CSRF tokens. |
| Constant-time password check, scrypt-hashed PINs, account lockout, login rate limit | No timing leaks or brute force. |
| One permission table used by both the server and the "What each role can do" screen | The help screen can't drift from what's enforced. |
| Options priced and "frozen" onto each order line | Later menu price changes don't rewrite old orders or reports. |
| Stock checked and counted down inside the same transaction as the order | Two tills can't both sell the last croissant. |
| shop.json seeds the menu; the database is the source of truth after that | Managers edit in the desk without touching files, and file updates don't undo their edits. |
| Pickup screen gets numbers only | It's public, so it can't leak names or orders. |
| Points spent and earned inside the order's transaction, with a ledger row for every change | A failed order never costs points, and every balance can be explained. |
| Public points lookup returns points and rewards only | Knowing a phone number doesn't reveal a name or history. |
| Server-Sent Events for the desk | Simple one-way live updates over plain HTTP. |
| Demo data created through the normal services | The demo follows the same rules as real use, and seeding tests those rules too. |
| `VACUUM INTO` for backups | A consistent snapshot while the app keeps running, with no extra tools. |
| Money formatted in the shop's locale, not the browser's | A US café shows "$4.75" on every till, not "US$4.75" on a till set to another region. |
| Request logs keep the path only | Query strings can contain phone numbers; logs shouldn't. |
| Offline mode (keyword search, no AI) | Develop and demo without an API key. |

## Getting started

Requires **Node.js 23.6+**, which runs TypeScript directly with no build step.

```bash
npm install
cp .env.example .env    # set STAFF_PASSWORD (8+ chars); add GEMINI_API_KEY for AI answers
npm start
```

- Customer chat: http://localhost:3000
- Staff desk: http://localhost:3000/desk. First log in with business ID `bean-and-byte`, username `owner`
  and the `STAFF_PASSWORD` from `.env`, then add your team on the **Staff** tab

Without `GEMINI_API_KEY` the chat runs in **offline mode**: keyword search, no AI-written answers,
and bookings through the form only. Get a free key at https://aistudio.google.com/apikey.

Other commands:

```bash
npm run dev                   # restart on file changes
npm run chat -- bean-and-byte # chat in the terminal
npm test                      # 140 tests
npm run typecheck
npm run screenshots           # README screenshots from a running demo (needs Edge or Chrome)
```

### Public demo mode

```bash
npm run start:demo        # or set DEMO_MODE=1
```

- Seeds a believable shift: orders in every kitchen stage, bookings, a loyalty member with points, stock counts
- The desk login shows one-tap **demo-barista / 2580** and **demo-manager / 1357** logins
- Data resets every night at `DEMO_RESET_HOUR` (default 04:00, shop time)
- The shared demo accounts can't be changed or deactivated, so one visitor can't lock out the rest
  (visitors can still try staff management on accounts they add themselves)

## Deploy

**Render (one click, free):** the repo includes a [`render.yaml`](render.yaml) blueprint.

1. Push the repo to GitHub (done).
2. In the [Render dashboard](https://dashboard.render.com): **New → Blueprint**, pick this repository, **Apply**.
3. Optional: in the service's **Environment** tab, add `GEMINI_API_KEY` for AI answers and chat bookings.
4. Paste the `https://….onrender.com` URL into this README.

The blueprint runs the public demo on the free plan with HTTPS, secure cookies and a daily AI-message cap.
The free plan sleeps when idle (the first visit takes a few seconds) and has no disk, which is fine
for the demo because it reseeds on start. For a real business, use a paid plan, remove `DEMO_MODE`
and add the disk shown in the file.

**Any Docker host:**

```bash
docker build -t support-bot .
docker run -p 3000:3000 -v support-data:/data -e STAFF_PASSWORD=change-me-please support-bot
```

**Production settings:** `DATA_DIR` (put it on a persistent disk), `TRUST_PROXY=1` behind a proxy,
`COOKIE_SECURE=1` with HTTPS, `DAILY_MESSAGE_LIMIT` to protect the AI quota.

**Backups:** a consistent copy of each shop database is saved every `BACKUP_EVERY_HOURS` (default 24)
to `<DATA_DIR>/<business>/backups`, keeping the newest 7. Run one any time with `npm run backup`;
it's safe while the server is running.

### Add your own business

```text
tenants/
  my-shop/
    tenant.json   # name, assistant name, tone, contact, brand color, suggested questions
    shop.json     # optional: timezone, opening hours, tables, booking rules, menu with prices
    docs/*.md     # FAQs, policies, menu text for the chatbot
```

Without `shop.json` the business gets the chatbot only. Data is stored in `data/<id>/` (git-ignored).

### API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tenants/:id` | Public business info |
| `POST` | `/api/tenants/:id/chat` | Chat. Body `{ message, history }`; responds with an SSE stream (`sources`, `action`, `delta`, `done`) |
| `GET` | `/api/tenants/:id/availability?date=&partySize=` | Free booking times |
| `GET` | `/api/tenants/:id/pickup`, `.../pickup/events` | Pickup screen numbers and live updates (public) |
| `GET` | `/api/tenants/:id/menu` | Public menu and today's pickup times |
| `POST` | `/api/tenants/:id/orders` | Order ahead: `{ name, phone, pickupTime, items, clientRef? }` |
| `POST` | `/api/tenants/:id/loyalty` | Points balance: `{ phone }` |
| `POST` | `/api/tenants/:id/bookings` | Book a table: `{ date, time, partySize, name, phone, notes? }` |
| `POST` | `/api/tenants/:id/bookings/lookup`, `.../cancel` | Customer: `{ reference, phone }` |
| `POST` | `/api/desk/login`, `/api/desk/logout` | Desk session (cookie): `{ tenantId, username, pin }` |
| `GET`, `POST`, `PATCH` | `/api/desk/orders`, `/api/desk/orders/:id` | Till and order queue; POST takes `items[].options`, `clientRef`, optional `payment` |
| `POST` | `/api/desk/orders/:id/pay`, `/api/desk/orders/:id/refund` | Take payment `{ method, tendered? }`; refund `{ reason }` (manager) |
| `GET` | `/api/desk/report?date=` | End-of-day report (manager) |
| `GET`, `POST` | `/api/desk/loyalty?phone=`, `/api/desk/loyalty` | Look up or join a member; orders take `memberId` and `rewardId` |
| `GET`, `POST`, `PATCH` | `/api/desk/staff`, `/api/desk/staff/:id` | Staff accounts (manager) |
| `GET`, `POST`, `PATCH` | `/api/desk/bookings`, `/api/desk/bookings/:id` | Bookings by day, status changes |
| `GET`, `POST`, `PATCH` | `/api/desk/menu`, `/api/desk/menu/:id` | Menu; PATCH `{ available }` or `{ stock }` (staff), item fields or `{ hidden }` (manager) |
| `GET` | `/api/desk/events` | Live change events (SSE) |

## Roadmap

- [x] RAG engine with citations, multi-tenant
- [x] Streaming web chat, rate-limited API, offline mode
- [x] Table bookings: rules engine, chat booking via function calling, booking form
- [x] Staff desk: till, order queue, bookings, menu, live updates
- [x] Drink options, cash/card payments, refunds, end-of-day report
- [x] Staff accounts with roles (customer / staff / manager)
- [ ] Integrated card payments (Stripe Terminal, test mode first)
- [x] Stock counts, menu & price editing in the desk
- [x] Chatbot reads the live menu; customer pickup screen
- [x] Loyalty points and order ahead
- [x] Deploy-ready: public demo mode, Dockerfile, Render blueprint, backups
- [x] Screenshots in this README
- [ ] Put the live demo URL in this README
- [ ] Booking confirmations by SMS/email; WhatsApp channel

## Privacy note

Bookings store a name and phone number in the business's local database. On Gemini's free tier,
Google may use prompts to improve its products, so don't use real customer data with the demo.
Use the paid tier for real businesses.

## License

MIT
