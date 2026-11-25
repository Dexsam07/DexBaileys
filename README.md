<div align="center">

# DexBaileys — v1.7.0

**Fast, clean WhatsApp Web library for Node.js — buttons, photo reactions, channels, status and LID helpers built in.**

Maintained by **Shyam Chaudhari** · **DEX SHYAM TECH**

[![Version](https://img.shields.io/badge/version-1.7.0-blue)](https://github.com/Dexsam07/DexBaileys)
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

### 2. Photo / sticker reactions (animated too)
**File:** `src/Socket/dex.ts`

Put up to 30 sticker or photo reactions on one message. Every distinct sticker is uploaded once and reused for 6 hours.

```js
await sock.sendStickerReaction(msg.key, [stickerA, stickerB], { count: 16, delayMs: 300 })
```

New in v1.3: moving stickers stay moving. An animated webp is detected on its own, and a photo, GIF or short video given as a Buffer is converted to a sticker first (first 6 seconds, 512x512, under 900 KB).

```js
import { makeStickerWebp, isAnimatedWebp } from 'dexbaileys'

await sock.sendStickerReaction(msg.key, videoBuffer, { count: 10 }) // converted automatically

const { data, isAnimated } = await makeStickerWebp(videoBuffer, { maxSeconds: 6, fps: 12 })
```

Photos and GIFs need the optional `sharp` package, videos need `ffmpeg` on the host. A ready webp needs neither.

**Emoji tap shortcut (v1.3):** put an emoji on any message and that message gets the photo reactions, no command needed.

```js
// only the linked account's own emoji triggers it by default
const tap = sock.stickerReactOnTap([stickerA, stickerB], { count: 16, delayMs: 300, emoji: ['🔥'] })
tap.stop()

// or run anything on an emoji tap
sock.onReactionTap(async ({ key, emoji, reactor }) => { /* ... */ }, {
	allow: e => sock.isSameUser(e.reactor, '917384287404'),
	cooldownMs: 3000
})
```

Removed reactions, reactions older than 60 seconds and taps inside the cooldown are ignored.

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

### 12. Session that survives a restart
**File:** `src/Utils/dex-bot.ts`

The whole session in one file (written atomically), plus a session string for hosts that wipe the disk on restart.

```js
import makeWASocket, { useSingleFileAuthState } from 'dexbaileys'

const auth = await useSingleFileAuthState('data/session.json', { sessionId: process.env.SESSION_ID })
const sock = makeWASocket({ auth: auth.state })
sock.ev.on('creds.update', auth.saveCreds)

// once logged in: put this string in the SESSION_ID env var
const sessionId = auth.exportSessionId()
```

The session string works like a password. Never post it in a chat or a public repo.

---

### 13. Group cache and group helpers
**Files:** `src/Utils/dex-bot.ts`, `src/Socket/dex.ts`

Group metadata is cached inside the socket and kept fresh from group events, so admin checks and group sends do not ask WhatsApp every time.

```js
const group = await sock.getGroup(jid)            // cached
const admins = await sock.groupAdmins(jid)
if (await sock.isGroupAdmin(jid, sender)) { /* ... */ }
if (await sock.isBotAdmin(jid)) { /* ... */ }

await sock.tagAll(jid, 'Meeting at 9')            // hidden tag
await sock.tagAll(jid, 'Admins', { adminsOnly: true, showList: true })
```

Pass your own `cachedGroupMetadata` in the config to use a different cache.

---

### 14. Message helper
**File:** `src/Utils/dex-bot.ts`

```js
sock.ev.on('messages.upsert', async ({ messages }) => {
	const m = sock.serialize(messages[0])
	if (m.fromMe || !m.text) return

	if (m.text === '.ping') await m.reply('pong')
	if (m.text === '.save' && m.quoted?.isMedia) {
		const file = await m.quoted.download()
		await m.react('✅')
	}
})
```

`m.text` also returns the id of a tapped button or list row. Other fields: `m.chat`, `m.sender`, `m.isGroup`, `m.pushName`, `m.type`, `m.mentions`, `m.isMedia`, `m.quoted`, `m.send()`, `m.delete()`, `m.download()`.

---

### 15. Anti-delete
**File:** `src/Utils/dex-bot.ts`

```js
const watcher = sock.onMessageDeleted(async ({ chat, deletedBy, message }) => {
	if (message) await sock.sendMessage(chat, { forward: message })
})
// watcher.stop()
```

Only messages the bot saw while it was running can be restored (2,000 messages, 6 hours by default).

---

### 16. Send with typing
**File:** `src/Socket/dex.ts`

```js
await sock.sendWithTyping(jid, { text: 'Hello there' })            // wait depends on text length
await sock.sendWithTyping(jid, { text: 'Hi' }, { typingMs: 1500 })
```

---

### 17. Status auto helper
**File:** `src/Utils/dex-bot.ts`

```js
const auto = sock.autoStatus({
	react: ['🔥', '❤️'],
	onStatus: async status => {
		if (status.isMedia) await fs.promises.writeFile(`status-${status.key.id}`, await status.download())
	}
})
// auto.stop()
```

---

### 18. Stickers with your pack name
**File:** `src/Utils/dex-plus.ts`

```js
// photo, GIF, short video or webp: converted if needed, then tagged
await sock.sendSticker(jid, buffer, { pack: 'DEX SHYAM TECH', author: 'Shyam' })

// or tag a webp yourself
const tagged = addStickerExif(webp, { pack: 'My Pack', author: 'Me', emojis: ['🔥'] })
```

---

### 19. Self-destruct, typewriter and scheduled messages
**File:** `src/Socket/dex.ts`

```js
// deleted for everyone after 30 seconds
const timer = await sock.sendSelfDestruct(jid, { text: 'OTP: 4821' }, 30)
// timer.cancel() keeps it

// one message that is edited until the full text stands
await sock.sendTypewriter(jid, 'Loading DEX menu, please wait', { steps: 5, delayMs: 700 })

// send later: a Date, or a delay in ms
const job = sock.schedule(jid, { text: 'Good morning' }, new Date('2026-12-01T07:00:00+05:30'))
sock.listScheduled()
sock.cancelScheduled(job.id)
```

Scheduled and self-destruct timers live in memory; they are lost if the process restarts.

---

### 20. Quiz polls, hidden voters, spoilers
**File:** `src/Utils/messages.ts`

```js
await sock.sendMessage(jid, { poll: { name: 'Capital of India?', values: ['Delhi', 'Mumbai'], correctAnswer: 'Delhi' } })
await sock.sendMessage(jid, { poll: { name: 'Vote', values: ['A', 'B'], hideVoter: true, canAddOption: true } })
await sock.sendSpoiler(jid, { text: 'tap to read' })
```

These are newer WhatsApp message types. Older WhatsApp apps may not show them.

---

### 21. Usernames
**File:** `src/Socket/dex.ts`

```js
const user = await sock.resolveUsername('@someone') // { username, jid, lid, pn, exists } or null
const names = await sock.fetchUsernames(jid1, jid2) // [{ jid, username }]
```

---

### 22. Channel status event
**File:** `src/Utils/dex-plus.ts`

```js
sock.ev.on('newsletter.status', status => {
	console.log(status.id, status.message, status.viewsCount, status.reactions)
})
```

---

### 23. Move a session, check health
**File:** `src/Utils/dex-plus.ts`

```js
// folder -> one file (or a SESSION_ID string -> folder / file), no pairing again
await migrateSession({ folder: 'auth_info' }, { file: 'session.json' })

sock.health() // { state, uptimeMs, lastMessageAt, messagesReceived, disconnects, lastDisconnectCode, healthy }
sock.health(10 * 60 * 1000) // healthy only if something arrived in the last 10 minutes
```

---

### 24. Session in a database
**File:** `src/Utils/dex-store.ts`

For hosts that wipe files on every restart (Railway, Render, Heroku, Koyeb). No extra package is installed by DexBaileys; bring the database client you already use.

```js
import { useKeyValueAuthState, mongoKeyValueStore, redisKeyValueStore } from 'dexbaileys'

// MongoDB
const { state, saveCreds, clear } = await useKeyValueAuthState(
  mongoKeyValueStore(db.collection('session')),
  { prefix: 'bot1:', sessionId: process.env.SESSION_ID } // both optional
)

// Redis (ioredis or node-redis)
await useKeyValueAuthState(redisKeyValueStore(redis))

// Keyv (any Keyv backend: SQLite, Postgres, MySQL, ...)
await useKeyValueAuthState(new Keyv('sqlite://session.sqlite'))

const sock = makeWASocket({ auth: state })
sock.ev.on('creds.update', saveCreds)
await clear() // after a logout

// move an existing login into the database, no pairing again
await migrateSession({ folder: 'auth_info' }, { store: mongoKeyValueStore(db.collection('session')) })
```

---

### 25. Speed pack
**Files:** `src/Utils/dex-store.ts`, `src/Defaults/index.ts`, `src/Socket/socket.ts`

Nothing to call, it is on by default:

- Device list cache lives 30 minutes (was 5) and the Signal key cache 15 minutes (was 5), so fewer lookups before each send
- Each connect asks WhatsApp which web version it is serving (kept for 1 hour, dropped on a `405`), so pairing does not fail on an old version. Passing your own `version` pins it; add `syncWaWebVersion: true` to keep the sync as well, or `syncWaWebVersion: false` to switch it off
- The Signal library's session dumps are hidden from the console (`quietSignalLogs: false` or `DEX_BAILEYS_VERBOSE=1` shows them again; errors are never hidden)
- A link preview that takes longer than 2.5 seconds is skipped and the text goes out without it (`linkPreviewTimeoutMs`)

---

### 26. HD photo and video
**Files:** `src/Utils/messages.ts`, `src/Utils/messages-media.ts`

```js
await sock.sendMessage(jid, { image: { url: './photo.jpg' }, caption: 'HD', hd: true })
await sock.sendHD(jid, { video: { url: './clip.mp4' } })
```

DexBaileys never re-compresses your file, with or without `hd`. What `hd: true` changes is the preview: 200 px wide instead of 32 px, so the photo looks sharp before it finishes loading.

---

### 27. Sticker pack in one message
**File:** `src/Utils/dex-pack.ts`, `src/Socket/dex.ts`

Send a whole pack (up to 60 stickers); the receiver adds it with one tap. Photos, GIFs and short videos are converted to stickers for you.

```js
await sock.sendStickerPack(jid, {
  name: 'DEX Pack',
  publisher: 'Shyam Chaudhari',
  description: 'optional',
  stickers: [webp1, webp2, { data: photoBuffer, emojis: ['🔥'] }],
  trayIcon: pngBuffer // optional: made from the first sticker when left out (needs sharp)
})
```

---

### 28. Group status
**File:** `src/Utils/dex-pack.ts`, `src/Socket/dex.ts`

Post a status inside a group: text, photo, video, voice note or sticker.

```js
await sock.sendGroupStatus(groupJid, { image: buffer, caption: 'Hello group' })
await sock.sendGroupStatus(groupJid, { text: 'Good morning' }, { backgroundColor: '#B00020' })
```

> Group status is a new WhatsApp feature. Members on an older app may not see it.

---

### 29. SQLite session
**File:** `src/Utils/dex-pack.ts`

The whole login in one `auth.db` file, using the SQLite built into Node (22.5 or newer). No extra package.

```js
import { useSqliteAuthState } from 'dexbaileys'

const { state, saveCreds, clear, close } = await useSqliteAuthState('./session/auth.db', {
  migrateFromFolder: 'auth_info',        // optional: copy an old session folder in once
  sessionId: process.env.SESSION_ID      // optional
})
const sock = makeWASocket({ auth: state })
sock.ev.on('creds.update', saveCreds)
```

---

### 30. More built in

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

**DexBaileys v1.7.0** — Maintained by Shyam Chaudhari (DEX SHYAM TECH)

MIT licence · see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)

</div>
