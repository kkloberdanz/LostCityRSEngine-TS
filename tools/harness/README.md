# Headless test harness

Runs the Lost City world in-process with no client and drives "headless" players through the real
client-packet handlers. Tests use `node:test`.

    npm run build                 # pack content first (after any content change)
    npm run test:harness          # all tests in tools/harness/tests
    npx tsx --test tools/harness/tests/phase0.test.ts

Run from `engine/`. Saves go to `data/players/harness/`. Env overrides are in `env.ts` (no login/friend/logger
servers, dev mode, members world).

## API sketch (`Harness.ts`)

- `boot()`, `shutdown()`, `tick(n)`, `tickUntil(pred, max, what)`. The world clock starts at tick 1000.
- `Bot.login(name, { at: [x, z, level], save: 'path.sav' })`. A fresh character has the tutorial completed.
- Actions are real packets: `walkTo`, `clickTile`, `opHeld`, `opLoc`, `opNpc`, `opObj`, `useHeldOnLoc/Npc/Held`,
  `ifButton`, `invButton`, `continueDialog`, `countDialog`, `closeModal`, `cheat`, `logoutAndWait`.
- Setup shortcuts (bypass gameplay): `teleport`, `give`, `clearInv`, `setLevel`, `setVarp`, `setVarbit`.
- State: `coord`, `inv()`, `worn()`, `count(obj)`, `varp`, `varbit`, `stat/baseStat/xp`, `hp`, `messages`,
  `modalMain/Chat/Side`, `myEvents('anim'|'spotanim'|'damage')`; world: `npcsNear`, `locsNear`, `objsNear`, `npcHp`,
  and the global `events` log (anims, spotanims, damage, npc say) for players and npcs.

## Engine paths that assume a NetworkPlayer, and the workarounds

- `World.processClientsOut` skips players without a connected client, so a plain `Player` never gets map/npc/zone
  updates: `originX/Z` stays unset (OpLoc's visible-area check fails), `rsbuf` never records which npcs it can see
  (OpNpc's `rsbuf.hasNpc` check fails, and npc hunting only runs for npcs with observers). Bots are real
  `NetworkPlayer`s on a `HarnessSocket` that counts as connected and discards the bytes. The encoders still run.
- `decodeIn()` reads socket bytes. The harness overrides it per bot to pass queued message objects to the
  registered handlers, so World's own input logic (moveClickRequest, delayed checks) runs around it unchanged.
- `World.cycle()` reschedules itself with `setTimeout`; the harness swallows that call. The dev rebuild thread is
  disabled, and `shutdown()` terminates the login/friend/logger workers that World creates on import.
- `NODE_DEBUG_SOCKET` ("doing headless bot testing!") is declared in Environment.ts but read nowhere.
- Content gotchas: a fresh world at tick 0 makes default-0 "last combat" varps look recent ("I'm already under
  attack"), so the clock starts at 1000. Fresh characters get `%tutorial = 1000` or combat XP is tutorial-capped.
  Logout during the combat timer is dropped, not deferred, so `logoutAndWait` re-requests every tick.
