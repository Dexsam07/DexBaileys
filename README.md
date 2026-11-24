<div align="center">

# DexBaileys — v1.2.1

**Fast, clean WhatsApp Web library for Node.js — buttons, photo reactions, channels, status and LID helpers built in.**

Maintained by **Shyam Chaudhari** · **DEX SHYAM TECH**

[![Version](https://img.shields.io/badge/version-1.2.1-blue)](https://github.com/Dexsam07/DexBaileys)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Channel](https://img.shields.io/badge/WhatsApp-DEX%20SHYAM%20TECH-25D366)](https://whatsapp.com/channel/0029VbBgXTsKwqSKZKy38w2o)

</div>

---

## What is DexBaileys?

DexBaileys is a WebSocket library for WhatsApp Web multi-device.
It is a drop-in replacement for Baileys v7: every normal Baileys API works the same way, so an existing bot keeps running without changes — and gets buttons, photo reactions, safer reconnects and owner checks that survive LIDs on top.

- No auto-follow of any channel, no hidden channel IDs, no remote config URLs
- No number ban-check tool that talks to WhatsApp registration servers
- Built `lib/` is committed, so nothing is compiled on install

---

## ✅ Features

### 1. Buttons, lists and carousels
**File:** `src/Utils/interactive.ts`

`sendMessage` accepts `buttons`, `sections` (list), `nativeFlow` (reply / link / copy / call / list buttons, with an optional image, video or document on top) and `cards` (carousel). The extra `biz` node WhatsApp needs is added automatically.

```js
// reply buttons
await sock.sendMessage(jid, {
	text: 'Choose one',
	footer: 'DexBaileys',
	buttons: [
		{ id: 'menu', text: 'Menu' },
		{ id: 'ping', text: 'Ping' }
	]
})

// list
await sock.sendMessage(jid, {
	text: 'All commands',
	buttonText: 'Open list',
	sections: [{ title: 'Main', rows: [{ title: 'Menu', id: '.menu', description: 'Show menu' }] }]
})

// link / copy / call / reply buttons, with an optional image on top
await sock.sendMessage(jid, {
	image: { url: 'https://example.com/photo.jpg' },
	caption: 'DEX SHYAM TECH',
	footer: 'Tap a button',
	nativeFlow: [
		{ text: 'Channel', url: 'https://whatsapp.com/channel/XXXXXXXX' },
		{ text: 'Copy code', copy: 'DEX-1234' },
		{ text: 'Owner', id: '.owner' }
	]
})

// carousel: every card needs an image or a video
await sock.sendMessage(jid, {
	text: 'Swipe',
	cards: [
		{ image: { url: 'https://example.com/1.jpg' }, title: 'One', caption: 'First', nativeFlow: [{ text: 'Pick', id: '1' }] },
		{ image: { url: 'https://example.com/2.jpg' }, title: 'Two', caption: 'Second', nativeFlow: [{ text: 'Pick', id: '2' }] }
	]
})
```

A tapped button arrives in `messages.upsert` as `buttonsResponseMessage`, `listResponseMessage` or
`interactiveResponseMessage`. WhatsApp decides which of these it renders on each app version, so test on a
real phone before relying on one.

---

### 2. Photo / sticker reactions
**File:** `src/Socket/dex.ts`

Put up to 30 sticker or photo reactions on one message. Every distinct sticker is uploaded once and reused.

```js
await sock.sendStickerReaction(msg.key, [stickerA, stickerB], { count: 16, delayMs: 300 })
```

---

### 3. Owner check that survives LIDs
**File:** `src/Utils/dex-extras.ts`

WhatsApp often sends a LID instead of a phone number, and bots then reject their own owner. `isSameUser` matches a number, bare digits, a device JID and the LID of one person.

```js
if (await sock.isSameUser(msg.key.participant || msg.key.remoteJid, '917384287404')) {
	/* owner */
}

const { pn, lid } = await sock.resolveUserJids('917384287404')
const lidJid = await sock.getLIDForPN('917384287404@s.whatsapp.net')
const pnJid = await sock.getPNForLID('123456789@lid')
```

---

### 4. Albums
**File:** `src/Socket/dex.ts`

```js
await sock.sendAlbum(jid, [
	{ image: { url: 'https://example.com/1.jpg' }, caption: 'One' },
	{ video: { url: './clip.mp4' } }
])
```

---

### 5. View-once download
**File:** `src/Socket/dex.ts`

Works on the view-once message itself or on a reply to it, and gives a clear error when the media key is gone.

```js
const { type, data, caption } = await sock.downloadViewOnce(msg)
```

---

### 6. Status helpers

```js
sock.ev.on('messages.upsert', async ({ messages }) => {
	const m = messages[0]
	if (m.key.remoteJid === 'status@broadcast' && !m.key.fromMe) {
		await sock.readStatus(m.key)
		await sock.reactToStatus(m.key, '🔥')
	}
})

await sock.sendStatus({ text: 'Hello from DexBaileys' })
```

Encrypted `<status>` stanzas are decoded like normal messages.

---

### 7. Channels (newsletters)
**File:** `src/Socket/newsletter.ts`

```js
const jid = await sock.newsletterJidFromInvite('https://whatsapp.com/channel/XXXXXXXX')
const info = await sock.newsletterMetadata('invite', 'https://whatsapp.com/channel/XXXXXXXX')
const mine = await sock.newsletterSubscribed()
```

Also: `newsletterFollow` subscribes to live updates, `newsletterVotePoll`, and a `newsletter.message` event. Nothing is ever followed unless your code calls `newsletterFollow`.

---

### 8. Reconnect manager
**File:** `src/Utils/reconnect-manager.ts`

```js
import makeWASocket, { createReconnectManager, fetchLatestWaWebVersion, useMultiFileAuthState } from 'dexbaileys'

const { state, saveCreds } = await useMultiFileAuthState('session')
const manager = createReconnectManager({
	connect: ({ version }) => makeWASocket({ auth: state, ...(version ? { version } : {}) }),
	onSocket: sock => {
		sock.ev.on('creds.update', saveCreds)
	},
	versionProvider: async () => (await fetchLatestWaWebVersion()).version,
	onGiveUp: code => console.log('stopped reconnecting, code', code)
})
await manager.start()
```

It waits 1s, 2s, 4s… (max 30s) between attempts, never reconnects a logged-out session, and never
runs two sockets at once.

---

### 9. Pairing and QR fixes
**File:** `src/Socket/socket.ts`

- `requestPairingCode('+91 73842-87404')` cleans the number, waits for the WhatsApp handshake, allows one request at a time and rolls back cleanly on failure
- The QR on screen is refreshed when WhatsApp rotates the pairing secret, so QR linking no longer hangs
- Pre-key upload stops retrying on a closed socket, and start-up queries no longer crash the connection when one of them fails

---

### 10. WhatsApp version memory
**File:** `src/Utils/dex-extras.ts`

Remembers the newest WhatsApp Web version on disk, so a restart or a failed version fetch never falls back to an older revision (the cause of repeated 408 disconnects).

```js
import { createVersionStore, fetchLatestWaWebVersion } from 'dexbaileys'

const versions = createVersionStore({ file: './session/wa-version.json', fetchLatest: fetchLatestWaWebVersion })
const sock = makeWASocket({ auth: state, version: await versions.resolve() })
```

---

### 11. Send queue
**File:** `src/Utils/dex-extras.ts`

Spaces out messages for broadcast style commands: global gap, per-chat gap and a per-minute cap.

```js
const queue = sock.createSendQueue({ minDelayMs: 1500, perChatDelayMs: 3000, maxPerMinute: 20 })
for (const jid of jids) queue.send(jid, { text: 'Hello' })
await queue.idle()
```

---

### 12. More built in

- Encrypted message edits are decrypted and emitted as `messages.update`
- `makeInMemoryStore` is included (bounded history, JSON snapshot)
- Large media is encrypted through a temp file instead of RAM
- Spoofed self-only protocol messages from other people are dropped
- Faster offline queue, parallel key-cache reads, TCP no-delay
- Default browser is `Browsers.macOS('Chrome')`; `Browsers.androidPhone('Chrome')` is available as an option

---

## Install

### From GitHub
```bash
npm install github:Dexsam07/DexBaileys
```

### In your `package.json`
```json
"dexbaileys": "github:Dexsam07/DexBaileys"
```

### In a bot that already imports `@whiskeysockets/baileys`
```json
"@whiskeysockets/baileys": "github:Dexsam07/DexBaileys"
```

Requires Node.js 20 or newer.

---

## Quick Start

```js
import makeWASocket, { useMultiFileAuthState } from 'dexbaileys'

const { state, saveCreds } = await useMultiFileAuthState('session')

const sock = makeWASocket({ auth: state })

sock.ev.on('creds.update', saveCreds)

sock.ev.on('messages.upsert', async ({ messages }) => {
	const m = messages[0]
	if (!m.message || m.key.fromMe) return
	await sock.sendMessage(m.key.remoteJid, { text: 'Hello from DexBaileys' })
})
```

CommonJS projects can load it with `const baileys = await import('dexbaileys')`, or with `require('dexbaileys')` on Node.js 22.12 or newer.

---

## Optional in-memory store

```js
import makeWASocket, { makeInMemoryStore, useMultiFileAuthState } from 'dexbaileys'

const store = makeInMemoryStore({ maxMessagesPerChat: 1000 })
store.readFromFile('./baileys_store.json')

const { state, saveCreds } = await useMultiFileAuthState('./session')
const sock = makeWASocket({
	auth: state,
	getMessage: async key => store.loadMessage(key.remoteJid, key.id)?.message
})

store.bind(sock.ev)
sock.ev.on('creds.update', saveCreds)
setInterval(() => store.writeToFile('./baileys_store.json'), 10_000).unref()
```

---

## Build from source

```bash
npm install --ignore-scripts
npm run build
npm test
```

---

## Disclaimer

This project is not affiliated with, associated with, authorized by, or endorsed by WhatsApp or Meta.
"WhatsApp" and related marks are registered trademarks of their respective owners.
Use responsibly and in accordance with WhatsApp's Terms of Service. Button, carousel and photo-reaction rendering depends on the WhatsApp app version, so test on a real phone.

---

<div align="center">

**DexBaileys v1.2.1** — Maintained by Shyam Chaudhari (DEX SHYAM TECH)

MIT licence · see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)

</div>
