# nfs3-webgl — architecture

Static recompilation of *Need for Speed III: Hot Pursuit* (PC, modern patch) to
WebAssembly + WebGL, following the approach of nfsu2-web / NFSU2Recomp.

The lifter runs on the host's `nfs3.exe`; generated C, the `.wasm` module and
all game files are git-ignored. The server publishes the browser build and the
configured game folder, including through public Tailscale Funnel. Browsers
download the game data automatically and cache it in OPFS.

## Target binary (analyzed 2026-11-05)

| | |
|---|---|
| File | `nfs3.exe`, 1,698,304 bytes, modern patch (English base) |
| SHA-256 | `3b0c829ef74580516942acecdb4767a6f5c8a15e917ee35346779b71654f44a0` |
| Format | PE32, ImageBase `0x400000`, entry RVA `0xF7FA0`, image size `0x653000` |
| `.code` | `0x401000`, 0x133000 bytes (~1.2 MB x86) |
| `.data`/`.bss` | `0x536000` / `0x56E000` (bss ≈ 4.7 MB) |
| `.reloc` | present → reliable pointer/jump-table discovery |

### Imports: 207 functions across 10 DLLs. This is the runtime surface we reimplement.

- **KERNEL32 (116):** files, heap, threads/events/critsec, TLS, file mapping, INI
  (`GetPrivateProfile*`), comm-port calls (serial play, which can be stubbed)
- **USER32 (50):** window/message loop, `GetAsyncKeyState`, cursor, DDE (stub)
- **WSOCK32 (25):** full BSD sockets (TCP + UDP). This is the game's own network play.
- **WINMM (7):** `timeSetEvent`/`timeGetTime` multimedia timers, `PlaySoundA`
- **DINPUT (1):** `DirectInputCreateA` (COM, so the vtable gets emulated)
- GDI32 (2), ADVAPI32 (4, registry), OLE32 (1), SHELL32 (1)

There is **no DirectDraw/Direct3D/DirectSound import.** Rendering goes through
a `LoadLibrary`'d **"thrash" driver** (`drivers/<name>/*.dll`, picked by
`ThrashDriver=` in `nfs3.ini`) with a fixed 45-function C ABI:

```
init is about restore idle sync selectdisplay setvideomode createwindow
destroywindow window clearwindow flushwindow lockwindow unlockwindow
pageflip readrect writerect getwindowtexture getstate setstate clip
talloc tfree treset tupdate tupdaterect settexture
drawpoint/line/tri/quad/sprite (+ strip / fan / mesh variants)
```

Audio goes through `eacsnd.dll` (EA's sound library, which also needs a replacement).

## Plan

1. **Lifter** (`tools/`, Python + Capstone + pefile). Walks every function
   reachable from the entry point, exports, relocations and jump tables, and
   emits C over an emulated CPU state (`ctx->eax`… flags, x87 FPU stack).
   Guest memory is a flat linear array mapped at the PE's virtual addresses.
2. **Runtime** (`runtime/`, C → wasm via wasi-sdk). Reimplements the 207
   imports. Win32 threads run as Web Workers over a `SharedArrayBuffer`.
3. **`thrash-webgl`.** A native implementation of the 45 thrash entry points
   on WebGL2. This replaces Direct3D/Glide entirely; it's the main shortcut
   compared with nfsu2-web, which had to emulate D3D9.
4. **`eacsnd` replacement** on Web Audio (AudioWorklet).
5. **Data loader.** The browser downloads the configured server game folder
   into OPFS, and `CreateFileA` and friends read from it. A completion marker
   prevents interrupted downloads from being mistaken for a ready game.
   A local folder picker remains available when no server game folder is configured.
6. **Online play.** The game already does multiplayer over WSOCK32
   TCP/UDP. The runtime maps sockets onto WebRTC data channels (UDP-like,
   unordered) plus WebSocket fallback, through a small signalling/relay server
   with regional instances. The game's own netcode then runs over the internet
   unchanged. Latency still depends on distance; regional relays keep it as
   low as possible.
7. **Deploy.** Static site (runtime, loader, thrash-webgl) plus a relay server
   (Docker). Players supply `nfs3.exe` + data. For a public site, the
   lift→compile step must run on the player's side, so EA's code is never
   served from our host. A browser-side build pipeline is a later milestone.
   Until then, the self-host build path works like nfsu2-web.

OpenNFS (format parsers for FRD/COL/FCE/QFS/VIV) is a reference for the data
formats and debugging tools, but the game logic comes from the recompiled exe.

## Status / bring-up notes (2026-11-05)

The native Linux build of the recompiled game reaches the intro animation and the main menu.

- Lifted modules: `nfs3.exe` (6,347 functions), the game's own software renderer
  `drivers/softtri/softtria.dll` (466), and `eacsnd.dll` (229, rebased 0x400000 → 0x61000000).
  The software driver is the first rendering path: exact game-expected
  behaviour, and later the reference for the native thrash→WebGL driver.
- Runtime: KERNEL32/USER32/WINMM/etc. plus DirectDraw and DirectSound subsets
  (`runtime/ddraw.c`, `runtime/dsound.c`). Frames are dumped as PPM for now.
- Debugging: `RT_TRACE=<hex,...>` (lifted-function entry/return with Watcom
  register args), `RT_TRACE_DUMP=1`, `RT_VERBOSE=2|3`, `RT_ALARM=<s>` under gdb,
  and `./re <pe> dis|xref|func|str|export`.

## Online play (2026-11-05)

NFS3's **IPX** mode (LAN game browser) is used for online play. The game's own
netcode is host-relayed lockstep. Every ~31 ms (32 Hz) each client sends its
controller input (≈16-byte packet) to the host. The host bundles all players'
inputs (≈43 bytes) and sends the bundle to everyone, and every machine
simulates all cars from those inputs. The host's own input therefore takes
effect at once, while a client's input needs one round trip to the host. That
is why clients lagged on 1999-era internet links. Packets are tagged `0xEA` +
`add`/`rsp`/`dat`/`ola`; `dat` packets carry the game's own sequence/ack bytes.

- `runtime/net.c`: WSOCK32 IPX sockets (`AF_IPX`, `SOCK_DGRAM`) on a virtual
  LAN. The 6-byte node address comes from the relay, broadcasts go to the whole
  room, and SAP (socket 0x452) handles game discovery. TCP/IP mode is refused.
- `web/relay.mjs` (mounted at `/net` by `serve.mjs`): rooms, node ids, WebRTC
  signalling and packet relay. Rooms are created explicitly from the page,
  with a name, an optional password (salted SHA-256, kept in memory only),
  2–8 players and listed or unlisted. A room disappears when its last member
  leaves. Clients that send `{t:'list'}` get the room browser (members, their
  server ping, and racing yes/no) on every change and every 4 s. Native test
  builds still create unlisted rooms on the fly with `RT_ROOM`.
- Lobby (page, before Start): your name, the room browser with an estimated
  ping (your round trip to the server plus the members' average), create and
  join forms, and the room page with the members, their direct/relay status
  and the best host. Players join the room before Start, so the WebRTC links
  are already up when the game opens its sockets. There's also a raw TCP or Unix-socket endpoint
  for native test builds (`--relay-tcp PORT|PATH`, `RT_NET=unix:PATH`).
- `web/net.js`: browsers open WebRTC data channels to every room member and
  fall back to the relay. The channels are UDP-like (unordered, no
  retransmits). Each message repeats the previous two packets, so a lost
  packet arrives with the next one (~31 ms) instead of after a resend round
  trip. Members share their ping tables, and the badge names the **best host**:
  the player whose worst round trip to anyone is smallest. Hosting matters
  because the host's input counts at once and a client's after one round trip
  to the host.
- Measured natively with `RT_NET_LOSS=10` (drop 10% of incoming packets): the
  game's own protocol already resends a lost packet about one tick later, and
  neither side's send rhythm ever paused for more than 33 ms. The remaining
  client lag is the round trip itself, which is inherent to lockstep. Removing
  it with rollback (snapshot the guest state, re-simulate on a misprediction)
  isn't practical for a recompiled binary, so online play trades strict
  lockstep for responsiveness (it's casual, not competitive):
- **Smoother play** (`runtime/net.c`, `RT_NETSYNC=0` turns it off). A client
  writes its newest controls into its own block of each bundle it receives, so
  its car reacts at once in its own game. Its game and the host's then drive
  that car differently, so each player's game is the authority for its own car
  and the host's for the AI cars. About 30 times a second each one sends those
  cars' physics state (88 bytes from car+0x98: position, velocity, speed,
  orientation, spin; port 0x7ea5), and the others overwrite theirs. Small
  position errors are blended out over a few updates. The host moves a client's
  car ahead by half the round trip, measured from the game's own acks.
  - Game packets (`\xEAdat`): `fe`, payload length, seq, ack, CRC-16 (BE),
    payload. A client's controls: `06 00` + steer, gas, brake, handbrake; a
    bundle: `06` + 8 such blocks, player k in block k. CRC: reflected, poly
    0xA001 (table at 0x566b54), init 0xFBEA, over the bytes from `fe` with the
    CRC bytes zero. A client learns its block from the acks.
  - Cars: 8 pointers at 0x5efac8, car k = player k, then the AI.
  - Measured natively (`RT_NET_DELAY`, `RT_CARLOG`): at an 80 ms round trip a
    client's steering reaches its game after 34 ms instead of 137 ms; both games
    keep the cars' paths within 0.3 m (95%).
- Runtime fixes that online play needed: `GetSystemMetrics(SM_NETWORK)` must
  be 1 (otherwise every network option is greyed out); `closesocket` must wake
  threads blocked in `recvfrom`/`select`; `WaitForMultipleObjects(bWaitAll)`
  must not consume auto-reset events early (this also fixed an occasional
  start-up hang).
- Test: `tools/nettest.sh` runs two headless native instances in one room.
  Verified: lobby discovery, join, and a 2-player race with synchronised timers.
