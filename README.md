# Nusky Jewellers POS

One program for the whole shop: selling, buying gold, stock, customers, staff and
customer messages, reports, and a live gold-rate board for the shop TV.

It runs on one computer (the "server computer"). Every counter, phone and the TV
opens it in a web browser over the shop network, so everyone sees the same data.

## Start it

1. Install Node.js 22.13 or newer (the LTS version from https://nodejs.org). Nothing else to install.
2. Double-click `start.bat` (or run `npm start` in this folder).
3. The window shows the addresses to use:
   - on the server computer: `http://localhost:3000`
   - on other counters: `http://<server address>:3000`
   - on the TV: `http://<server address>:3000/tv`

First sign-in: username `admin`, password `admin123`. You are asked to choose
your own password straight away, and nothing else opens until you do.

If other computers cannot open the address, allow Node.js through Windows
Firewall on the server computer (Windows asks the first time it starts).

## First-day setup

1. **Settings**: shop name, address, phone, currency, tax, country calling code.
2. **Settings > Staff accounts**: one account per person. Add branches first if you have more than one.
3. **Gold rates**: enter today's selling and buying rate for 24K, 22K, 21K and 18K.
   Selling is blocked for a karat until its rate is set.
4. **Stock**: add each piece with its karat, weight and making charge. Leave the tag number empty to get one automatically (`NJ-000001`).
5. **Shop TV**: open the link shown there in the TV's browser.

## What each page does

| Page | What it is for |
| --- | --- |
| Today | Current rates and today's sales, gold bought and cash position. |
| Sell | Scan or search a tag, add to the bill, take old gold in exchange, take cash, card or bank transfer, print the invoice. |
| Buy gold | Buy gold from a customer by karat and weight at the buying rate, print a voucher for them to sign. |
| Stock | Every piece, by tag, karat, weight and branch. Today's price is worked out from the live rate. |
| Customers | Contact and ID details, with everything they bought and sold. |
| Bills and vouchers | Find, reprint or cancel past invoices and vouchers. |
| Gold rates | Set the rates. Counters and the TV change immediately. Keeps a history. |
| Messages | Staff chat (everyone, or one to one) and messages to customers by WhatsApp or SMS. |
| Shop TV | The TV link, the wording and pictures on the TV board, and a live preview. |
| Reports | Sales, gold bought, payments, weight by karat, staff totals and stock for any dates. |
| Settings | Shop details, staff accounts, branches, backup. |

## Keys on the Sell screen

The Sell screen is built to be worked from the keyboard, with the scanner always ready.

| Key | What it does |
| --- | --- |
| Scan or type a tag, then Enter | Adds that piece to the bill |
| F1 | Search stock by name. Arrow keys to move, Enter to add |
| F4 | Choose the customer |
| F6 | Add old gold taken in exchange |
| F8 | Jump to the discount |
| F9 | Fill cash with the exact amount due |
| F7 / F5 | Put the bill on hold / bring a held bill back |
| F2 | Open a copy of your last bill to reprint |
| F10 | Complete the sale and open the invoice to print |
| Esc | Clear the bill (asks first) |

To sell something that is not in stock, type a description in the Item box,
fill in karat, weight and making, and press Enter.

Held bills are kept on the computer where they were held, per staff member.
They do not reserve the stock: the sale is checked again when it is completed.

How a price is worked out: `weight x rate per gram for that karat + making charge`,
minus discount, plus tax if you set one. Old gold taken in exchange is valued at
the buying rate and taken off the amount due.

## Who can do what

- **Cashier**: sell, buy gold, customers, messages, view stock and bills.
- **Manager**: also set rates, add and edit stock, cancel bills, reports, TV message.
- **Admin**: everything, including staff accounts, branches, settings and backup.

Cashiers cannot change the rate on a bill unless an admin allows it in Settings.

## The TV board

The TV shows the date, shop name and clock, today's price for each karat, a
slideshow of your jewellery photos, three selling points with your phone
number, and a scrolling offer line. Set it all up on the Shop TV page:

- **Design**: six boards, each with its own layout and movement. Royal gold
  (black and gold, photo beside the prices), Cinema (photos fill the screen,
  prices in glass cards), Exchange (trading-floor board with flipping digits
  and up/down arrows), Spotlight (one karat at a time, enormous), Boutique
  (light catalogue look with hand-drawn ornaments) and Classic board (prices
  only, no photo). To show a design on the TV without changing the setting,
  add `?theme=cinema` (or royal, exchange, spotlight, boutique, board) to the
  TV address.
- **Pictures**: press "Add pictures" and choose photos of your jewellery (wide
  photos fit best, up to 20). Until you add some, the TV shows the shop emblem.
- **Prices**: choose per gram or per pavan (8 grams), and whether to show the
  buying price as well. Prices of 1,000 or more are shown without cents.
- **Wording**: the line under the shop name, the three selling points, and the
  scrolling offer. The phone number comes from Settings.

Every change, and every rate update, appears on the TV within a second. No
need to touch the TV.

## Customer messages

- **WhatsApp** works without any setup: the program prepares each message and a
  button opens WhatsApp with the text typed in. A person presses send. WhatsApp
  must be signed in on that computer or phone.
- **SMS** needs an account with an SMS provider. Paste their sending address
  into Settings > SMS gateway address, with `{to}` and `{message}` as placeholders.

## Your data

Everything is stored in `data/nusky.db` on the server computer.
Settings > Backup downloads a copy. Do this daily and keep it off this computer.
To restore, stop the program, replace `data/nusky.db` with the backup, and start again.

The TV pictures are kept separately in the `data/tv` folder and are not part of
that download. Copy that folder too if you want them backed up.

## Limits to know about

- On the server computer it works inside the shop network. To use it from
  anywhere, host it on the internet (see below).
- The TV page needs no sign-in, so anyone who has the address can open it. It
  only shows what the TV shows.
- Customers pay in full at the time of sale. Credit, advances and instalments
  are not tracked.

## Hosting it on the internet

This is a program that keeps running (a Node.js server), not a folder of web
pages, so it cannot be uploaded like an ordinary website. The host needs:

- **Node.js 22.13 or newer**, with a way to keep an app running. On cPanel this
  is the "Setup Node.js App" tool; a VPS works too.
- **A folder that keeps its files** between restarts, for `data/` (the database
  and the TV photos).
- **HTTPS** on the address. The sign-in cookie is then sent only over HTTPS.

Steps on cPanel:

1. Create the subdomain and note its folder.
2. In "Setup Node.js App", create an application: Node.js 22 or newer,
   application root set to the folder holding these files, application URL set
   to the subdomain, startup file `server.js`.
3. Put the files there (cPanel's "Git Version Control" can pull this
   repository) and restart the application.
4. Open the address and sign in as `admin` / `admin123`. It makes you choose a
   new password before anything else opens.

The data on the shop's own computer is not copied by this. To move it, stop
both copies and upload the `data/` folder.

## For developers

No dependencies. Node's built-in `node:sqlite` and `http` are used.

- `server.js` - static files and startup
- `src/db.js` - schema and first-run seed
- `src/api.js` - every `/api` route, validation and money maths (the server recomputes all totals)
- `public/` - the app (`index.html`, `js/`, `css/`) and the TV board (`tv.html`). `js/pos.js` is the Sell screen.
- `npm test` - end-to-end check against a temporary database

Environment variables: `PORT` (default 3000), `NUSKY_DATA_DIR` (default `./data`).
