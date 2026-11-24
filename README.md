# DexBaileys

WhatsApp Web WebSocket library by **DEX SHYAM TECH** (Shyam Chaudhari).

DexBaileys is a drop-in replacement for Baileys v7: every normal Baileys API works the same way, with
extra helpers for buttons, photo reactions, status, channels and LIDs on top.

> Not affiliated with WhatsApp or Meta. Use it within WhatsApp's Terms of Service.

## What is added on top of Baileys

| Area | Added |
| --- | --- |
| Status | `sock.readStatus(key)`, `sock.reactToStatus(key, emoji)`, `sock.sendStatus(content)`, and encrypted `<status>` stanzas are decoded like normal messages |
| Channels | `sock.newsletterJidFromInvite(linkOrCode)`, `newsletterMetadata('invite', fullLink)` accepts a full channel link, `newsletterFollow` also subscribes to live updates, `newsletterVotePoll`, new `newsletter.message` event |
| Edits | Encrypted message edits (`secretEncryptedMessage`) are decrypted and emitted as `messages.update` |
| LID | `sock.getLIDForPN(jid)` and `sock.getPNForLID(lid)` |
| Pairing code | `requestPairingCode` waits for the WhatsApp handshake before sending |
| Store | `makeInMemoryStore` is back |
| Buttons (v1.1) | `sendMessage` accepts `buttons`, `sections` (list), `nativeFlow` (reply / link / copy / call / list buttons) and `cards` (carousel). The `biz` node WhatsApp needs is added automatically |
| Photo react (v1.2) | `sock.sendStickerReaction(key, stickers, { count })` puts up to 30 sticker / photo reactions on a message |
| Owner check (v1.2) | `sock.isSameUser(a, b)` and `sock.resolveUserJids(jid)` match a phone number with its LID |
| Album (v1.2) | `sock.sendAlbum(jid, [{ image }, { video }])` |
| View once (v1.2) | `sock.downloadViewOnce(msg)` also works on a reply, with a clear error when the media key is gone |
| Version memory (v1.2) | `createVersionStore({ file })` never falls back to an older WhatsApp Web version after a restart |
| Channels (v1.2) | `sock.newsletterSubscribed()` lists the channels the account follows |
| Send queue (v1.2) | `sock.createSendQueue()` spaces out messages (global gap, per-chat gap, per-minute cap) |
| Connection (v1.1) | `createReconnectManager()` with backoff, QR refresh on `companion_reg_refresh`, pairing number clean-up + single request at a time, safer pre-key upload and init queries |
| Speed | Faster offline queue, parallel key-cache reads, TCP no-delay, no websocket compression |

## What is deliberately NOT included

- No auto-follow of any channel, no hidden channel IDs, no remote config URLs.
- No number ban-check utility that talks to WhatsApp registration servers.
- The default browser stays `Browsers.macOS('Chrome')` and upstream timeouts are kept.
  `Browsers.androidPhone('Chrome')` exists as an option, but it is off by default.

## Install

```bash
npm i github:Dexsam07/DexBaileys
```

To use it in a bot that already imports `@whiskeysockets/baileys` or `baileys`, alias it in `package.json`:

```json
"dependencies": {
  "@whiskeysockets/baileys": "github:Dexsam07/DexBaileys"
}
```

Requires Node.js 20 or newer. The built `lib/` folder is committed, so no build step runs on install.

## Quick start

```js
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'dexbaileys'

const { state, saveCreds } = await useMultiFileAuthState('session')
const sock = makeWASocket({ auth: state })
sock.ev.on('creds.update', saveCreds)

sock.ev.on('messages.upsert', async ({ messages }) => {
	const m = messages[0]
	if (m.key.remoteJid === 'status@broadcast' && !m.key.fromMe) {
		await sock.readStatus(m.key)
		await sock.reactToStatus(m.key, '🔥')
	}
})

const jid = await sock.newsletterJidFromInvite('https://whatsapp.com/channel/XXXXXXXX')
```

## Buttons, lists and carousels

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

## Reconnecting

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

## v1.2 helpers

```js
// photo / sticker reactions (webp buffers or { url })
await sock.sendStickerReaction(msg.key, [stickerA, stickerB], { count: 16, delayMs: 300 })

// owner check that survives LIDs
if (await sock.isSameUser(msg.key.participant || msg.key.remoteJid, '917384287404')) {
	/* owner */
}

// album
await sock.sendAlbum(jid, [{ image: { url: 'https://example.com/1.jpg' }, caption: 'One' }, { video: { url: './clip.mp4' } }])

// view once, from the message itself or from a reply to it
const { type, data, caption } = await sock.downloadViewOnce(msg)

// spaced-out sending for broadcast style commands
const queue = sock.createSendQueue({ minDelayMs: 1500, perChatDelayMs: 3000, maxPerMinute: 20 })
for (const jid of jids) queue.send(jid, { text: 'Hello' })
await queue.idle()

// remember the newest WhatsApp Web version across restarts
import { createVersionStore, fetchLatestWaWebVersion } from 'dexbaileys'
const versions = createVersionStore({ file: './session/wa-version.json', fetchLatest: fetchLatestWaWebVersion })
const sock2 = makeWASocket({ auth: state, version: await versions.resolve() })
// with createReconnectManager: versionProvider: () => versions.resolve()
```

Already part of the Baileys base, so nothing new was needed: media is encrypted through a temp file
instead of RAM (large files), channel posts accept media, and spoofed self-only protocol messages
(history sync, app-state key share, LID migration) from other people are dropped.

CommonJS projects can load it with `const baileys = await import('dexbaileys')`, or with
`require('dexbaileys')` on Node.js 22.12 or newer.

## Build from source

```bash
npm install --ignore-scripts
npm run build
npm test
```

## Licence

MIT. Maintained by Shyam Chaudhari (DEX SHYAM TECH). DexBaileys is built on open-source MIT work;
the required attribution is in `LICENSE` and `NOTICE`.
