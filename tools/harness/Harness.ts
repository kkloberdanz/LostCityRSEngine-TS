// Headless test harness for Lost City 377.
//
// Boots the World in-process (no TCP/web listeners), steps game ticks on demand, and drives "headless"
// players through the same client-packet handlers a real client uses.
//
// Design notes (engine paths that assume a NetworkPlayer, and how the harness copes):
// - A plain `Player` (client = null) never gets map/npc/zone updates in World.processClientsOut, which gate on
//   isClientConnected(). Without them `originX/Z` is never set (OpLoc bounds check fails), rsbuf never records
//   which npcs the player can see (OpNpc's rsbuf.hasNpc check fails, and npc hunting only runs for npcs with
//   observers). So headless players are real NetworkPlayers on a `HarnessSocket` that counts as connected and
//   swallows output bytes. The full output path (encoders included) still runs every tick.
// - Input: NetworkPlayer.decodeIn() normally decodes bytes from the socket. The harness overrides decodeIn on the
//   instance to hand queued ClientGameMessage objects straight to the registered handlers, so World's own
//   processClientsIn logic (moveClickRequest, delayed checks) runs unchanged around it.
// - Ticks: World.cycle() reschedules itself with setTimeout; the harness swallows that one call so tests control
//   time. World.start(false, false) skips the auto cycle. The dev file-watcher thread is disabled.
// - World creates login/friend/logger worker threads on import; shutdown() terminates them.

import './env.js';

import fs from 'fs';

import World from '#/engine/World.js';
import { NetworkPlayer } from '#/engine/entity/NetworkPlayer.js';
import Player from '#/engine/entity/Player.js';
import Npc from '#/engine/entity/Npc.js';
import Loc from '#/engine/entity/Loc.js';
import Obj from '#/engine/entity/Obj.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import { NpcStat } from '#/engine/entity/NpcStat.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { findPath, findPathToEntity, findPathToLoc, reachedEntity } from '#/engine/GameMap.js';
import ClientSocket from '#/server/ClientSocket.js';
import Packet from '#/io/Packet.js';
import { CoordGrid } from '#/engine/CoordGrid.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import ScriptRunner from '#/engine/script/ScriptRunner.js';

import Component from '#/cache/config/Component.js';
import InvType from '#/cache/config/InvType.js';
import LocType from '#/cache/config/LocType.js';
import NpcType from '#/cache/config/NpcType.js';
import ObjType from '#/cache/config/ObjType.js';
import SeqType from '#/cache/config/SeqType.js';
import SpotanimType from '#/cache/config/SpotanimType.js';
import VarBitType from '#/cache/config/VarBitType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';

import ClientGameMessage from '#/network/game/client/ClientGameMessage.js';
import ClientGameProt from '#/network/game/client/ClientGameProt.js';
import ClientGameProtRepository from '#/network/game/client/ClientGameProtRepository.js';
import MoveClick from '#/network/game/client/model/MoveClick.js';
import OpHeld from '#/network/game/client/model/OpHeld.js';
import OpHeldU from '#/network/game/client/model/OpHeldU.js';
import OpLoc from '#/network/game/client/model/OpLoc.js';
import OpLocU from '#/network/game/client/model/OpLocU.js';
import OpNpc from '#/network/game/client/model/OpNpc.js';
import OpNpcU from '#/network/game/client/model/OpNpcU.js';
import OpObj from '#/network/game/client/model/OpObj.js';
import IfButton from '#/network/game/client/model/IfButton.js';
import InvButton from '#/network/game/client/model/InvButton.js';
import ResumePauseButton from '#/network/game/client/model/ResumePauseButton.js';
import ResumePCountDialog from '#/network/game/client/model/ResumePCountDialog.js';
import CloseModal from '#/network/game/client/model/CloseModal.js';
import ClientCheat from '#/network/game/client/model/ClientCheat.js';
import ServerGameMessage from '#/network/game/server/ServerGameMessage.js';
import MessageGame from '#/network/game/server/model/MessageGame.js';

export { NpcStat, PlayerStat };

// ---- event log (animations, spotanims, damage, say) for players and npcs ----

export type HarnessEvent = {
    tick: number;
    kind: 'anim' | 'spotanim' | 'damage' | 'say';
    who: 'player' | 'npc';
    id: number; // player slot / npc nid
    name: string; // username / npc debugname
    value: number | string; // anim/spotanim id, damage amount, said text
    label?: string; // seq/spotanim debugname
};

export const events: HarnessEvent[] = [];

function npcName(npc: Npc): string {
    return NpcType.get(npc.type).debugname ?? String(npc.type);
}

function instrument(): void {
    const pAnim = Player.prototype.playAnimation;
    Player.prototype.playAnimation = function (anim: number, delay: number) {
        if (anim !== -1) events.push({ tick: World.currentTick, kind: 'anim', who: 'player', id: this.slot, name: this.username, value: anim, label: SeqType.get(anim)?.debugname ?? undefined });
        return pAnim.call(this, anim, delay);
    };
    const nAnim = Npc.prototype.playAnimation;
    Npc.prototype.playAnimation = function (anim: number, delay: number) {
        if (anim !== -1) events.push({ tick: World.currentTick, kind: 'anim', who: 'npc', id: this.nid, name: npcName(this), value: anim, label: SeqType.get(anim)?.debugname ?? undefined });
        return nAnim.call(this, anim, delay);
    };
    const pSpot = Player.prototype.spotanim;
    Player.prototype.spotanim = function (spot: number, height: number, delay: number) {
        if (spot !== -1) events.push({ tick: World.currentTick, kind: 'spotanim', who: 'player', id: this.slot, name: this.username, value: spot, label: SpotanimType.get(spot)?.debugname ?? undefined });
        return pSpot.call(this, spot, height, delay);
    };
    const nSpot = Npc.prototype.spotanim;
    Npc.prototype.spotanim = function (spot: number, height: number, delay: number) {
        if (spot !== -1) events.push({ tick: World.currentTick, kind: 'spotanim', who: 'npc', id: this.nid, name: npcName(this), value: spot, label: SpotanimType.get(spot)?.debugname ?? undefined });
        return nSpot.call(this, spot, height, delay);
    };
    const pDmg = Player.prototype.applyDamage;
    Player.prototype.applyDamage = function (damage: number, type: number) {
        events.push({ tick: World.currentTick, kind: 'damage', who: 'player', id: this.slot, name: this.username, value: damage });
        return pDmg.call(this, damage, type);
    };
    const nDmg = Npc.prototype.applyDamage;
    Npc.prototype.applyDamage = function (damage: number, type: number) {
        events.push({ tick: World.currentTick, kind: 'damage', who: 'npc', id: this.nid, name: npcName(this), value: damage });
        return nDmg.call(this, damage, type);
    };
    const nSay = Npc.prototype.say;
    Npc.prototype.say = function (text: string) {
        events.push({ tick: World.currentTick, kind: 'say', who: 'npc', id: this.nid, name: npcName(this), value: text });
        return nSay.call(this, text);
    };
}

// ---- world control ----

let booted = false;

export async function boot(): Promise<void> {
    if (booted) return;
    booted = true;

    if (!fs.existsSync('data/pack/server/script.dat')) {
        throw new Error('No packed data: run `npm run build` in engine/ first (and run the harness from engine/).');
    }

    // no file watcher / rebuild thread in tests
    (World as any).createDevThread = () => {};
    instrument();

    await World.start(false, false);

    // A fresh world starts at tick 0, so "within the last N ticks" checks against default-0 varps
    // (e.g. %lastcombat_pvp + 8 > map_clock -> "I'm already under attack") fire for the first ticks.
    // A live server has been up far longer; start the clock somewhere realistic.
    World.currentTick = 1000;
}

/** Advance the world by n ticks (each is one full World.cycle()). */
export function tick(n: number = 1): void {
    const realSetTimeout = globalThis.setTimeout;
    for (let i = 0; i < n; i++) {
        // World.cycle() ends by scheduling itself; swallow that so the harness owns time.
        (globalThis as any).setTimeout = (fn: any, ms?: number, ...args: any[]) => {
            if (typeof fn === 'function' && fn.name === 'bound cycle') return 0 as any;
            return realSetTimeout(fn, ms, ...args);
        };
        try {
            for (const bot of Bot.all) bot.keepAlive();
            World.cycle();
        } finally {
            globalThis.setTimeout = realSetTimeout;
        }
    }
}

/** Tick until pred() is true. Returns the number of ticks taken; throws after max ticks. */
export function tickUntil(pred: () => boolean, max: number = 100, what: string = 'condition'): number {
    for (let i = 0; i <= max; i++) {
        if (pred()) return i;
        tick();
    }
    throw new Error(`tickUntil: ${what} not met after ${max} ticks`);
}

export function shutdown(): void {
    for (const t of ['loginThread', 'friendThread', 'loggerThread', 'devThread']) {
        (World as any)[t]?.terminate?.();
    }
}

/** Run a debugproc / any script by its full name, e.g. "[proc,foo]", as a given player. */
export function runScript(bot: Bot, name: string, args: (number | string)[] = []): void {
    const script = ScriptProvider.getByName(name);
    if (!script) throw new Error(`no script ${name}`);
    bot.player.executeScript(ScriptRunner.init(script, bot.player, null, args), true);
}

// ---- config lookups ----

function need(id: number, what: string, name: string): number {
    if (id === -1) throw new Error(`unknown ${what}: ${name}`);
    return id;
}
export const objId = (n: string) => need(ObjType.getId(n), 'obj', n);
export const npcTypeId = (n: string) => need(NpcType.getId(n), 'npc', n);
export const locTypeId = (n: string) => need(LocType.getId(n), 'loc', n);
export const seqId = (n: string) => need(SeqType.getId(n), 'seq', n);
export const spotanimId = (n: string) => need(SpotanimType.getId(n), 'spotanim', n);
export const invId = (n: string) => need(InvType.getId(n), 'inv', n);
export const comId = (n: string) => need(Component.getId(n), 'component', n);
export const varpId = (n: string) => need(VarPlayerType.getId(n), 'varp', n);
export const varbitId = (n: string) => need(VarBitType.getId(n), 'varbit', n);

const toId = (v: number | string, f: (n: string) => number) => (typeof v === 'number' ? v : f(v));

// ---- world queries ----

export function npcsNear(x: number, z: number, level: number, radius: number = 15, type?: number | string): Npc[] {
    const t = type === undefined ? undefined : toId(type, npcTypeId);
    const out: Npc[] = [];
    for (const npc of World.npcs) {
        if (!npc.isActive || npc.level !== level) continue;
        if (Math.abs(npc.x - x) > radius || Math.abs(npc.z - z) > radius) continue;
        if (t !== undefined && npc.type !== t) continue;
        out.push(npc);
    }
    out.sort((a, b) => Math.max(Math.abs(a.x - x), Math.abs(a.z - z)) - Math.max(Math.abs(b.x - x), Math.abs(b.z - z)));
    return out;
}

function* zonesAround(x: number, z: number, level: number, radius: number) {
    for (let zx = (x - radius) & ~7; zx <= x + radius; zx += 8) {
        for (let zz = (z - radius) & ~7; zz <= z + radius; zz += 8) {
            yield World.gameMap.getZone(zx, zz, level);
        }
    }
}

export function locsNear(x: number, z: number, level: number, radius: number = 10, type?: number | string): Loc[] {
    const t = type === undefined ? undefined : toId(type, locTypeId);
    const out: Loc[] = [];
    for (const zone of zonesAround(x, z, level, radius)) {
        for (const loc of zone.getAllLocsSafe()) {
            if (Math.abs(loc.x - x) > radius || Math.abs(loc.z - z) > radius) continue;
            if (t !== undefined && loc.type !== t) continue;
            out.push(loc);
        }
    }
    return out;
}

export function objsNear(x: number, z: number, level: number, radius: number = 10, type?: number | string): Obj[] {
    const t = type === undefined ? undefined : toId(type, objId);
    const out: Obj[] = [];
    for (const zone of zonesAround(x, z, level, radius)) {
        for (const obj of zone.getAllObjsSafe()) {
            if (Math.abs(obj.x - x) > radius || Math.abs(obj.z - z) > radius) continue;
            if (t !== undefined && obj.type !== t) continue;
            out.push(obj);
        }
    }
    return out;
}

export const npcHp = (npc: Npc) => npc.levels[NpcStat.HITPOINTS];

// ---- headless player ----

class HarnessSocket extends ClientSocket {
    closed = false;
    bytesOut = 0;
    constructor() {
        super();
        this.remoteAddress = '127.0.0.1';
    }
    send(src: Uint8Array): void {
        this.bytesOut += src.length;
    }
    close(): void {
        this.closed = true;
    }
    terminate(): void {
        this.closed = true;
    }
}

export type BotOptions = {
    save?: string | Uint8Array; // path to a .sav, or raw bytes; omitted = brand-new character
    at?: [number, number, number?]; // place here before login (x, z, level)
    staffModLevel?: number;
    tutorial?: boolean; // true = leave a brand-new character mid-tutorial (default: mark the tutorial complete)
};

export class Bot {
    static all: Set<Bot> = new Set();

    readonly player: NetworkPlayer;
    readonly socket: HarnessSocket;
    readonly sent: ServerGameMessage[] = [];
    readonly messages: string[] = []; // MessageGame text, in order
    private pending: { prot: ClientGameProt; msg: ClientGameMessage }[] = [];

    private constructor(player: NetworkPlayer, socket: HarnessSocket) {
        this.player = player;
        this.socket = socket;

        const origWrite = player.writeInner.bind(player);
        player.writeInner = (message: ServerGameMessage) => {
            this.sent.push(message);
            if (message instanceof MessageGame) this.messages.push(message.msg);
            origWrite(message);
        };

        // feed queued messages to the real handlers inside World.processClientsIn
        player.decodeIn = () => {
            player.userPath = [];
            player.opcalled = false;
            player.lastConnected = World.currentTick;
            const batch = this.pending;
            this.pending = [];
            for (const { prot, msg } of batch) {
                const handler = ClientGameProtRepository.getHandler(prot);
                if (!handler) throw new Error(`no handler for prot ${prot.id}`);
                handler.handle(msg, player);
            }
            if (batch.length > 0) player.lastResponse = World.currentTick;
            return true;
        };
    }

    /** Create a headless player and log it in (ticks until it is in the world). */
    static login(username: string, opts: BotOptions = {}): Bot {
        const save = typeof opts.save === 'string' ? new Uint8Array(fs.readFileSync(opts.save)) : (opts.save ?? new Uint8Array());
        const socket = new HarnessSocket();
        const player = PlayerLoading.load(username, new Packet(save), socket) as NetworkPlayer;
        player.session = 'harness';
        player.staffModLevel = opts.staffModLevel ?? 0;
        player.lowMemory = false;
        player.members = true;
        player.messageCount = 0;
        if (opts.at) {
            player.x = opts.at[0];
            player.z = opts.at[1];
            player.level = opts.at[2] ?? 0;
        }
        if (save.length < 2 && !opts.tutorial) {
            // fresh character: finished Tutorial Island (^tutorial_complete = 1000), else combat xp is capped etc.
            player.setVar(varpId('tutorial'), 1000);
        }
        const bot = new Bot(player, socket);
        Bot.all.add(bot);
        // A logout's save is confirmed by the login worker via an async message, which never arrives while
        // the harness ticks synchronously. The harness has the save bytes already, so drop the pending flush.
        World.logoutRequests.delete(player.username);
        World.newPlayers.add(player);
        tickUntil(() => player.slot !== -1 && player.isActive, 5, `${username} login`);
        tick(); // first full tick in world (login scripts, initial info)
        return bot;
    }

    /** Test-only: top hitpoints up to full before every tick, so long fights can't kill the bot. */
    immortal = false;

    keepAlive(): void {
        if (this.player.isActive) {
            this.player.lastResponse = World.currentTick;
            if (this.immortal) this.player.levels[PlayerStat.HITPOINTS] = this.player.baseLevels[PlayerStat.HITPOINTS];
        }
    }

    send(prot: ClientGameProt, msg: ClientGameMessage): void {
        this.pending.push({ prot, msg });
    }

    // ---- state ----

    get x() {
        return this.player.x;
    }
    get z() {
        return this.player.z;
    }
    get level() {
        return this.player.level;
    }
    get coord(): [number, number, number] {
        return [this.player.x, this.player.z, this.player.level];
    }
    get online() {
        return this.player.isActive && World.getPlayerByUsername(this.player.username) === this.player;
    }
    get hp() {
        return this.player.levels[PlayerStat.HITPOINTS];
    }

    stat(s: PlayerStat) {
        return this.player.levels[s];
    }
    baseStat(s: PlayerStat) {
        return this.player.baseLevels[s];
    }
    xp(s: PlayerStat) {
        return this.player.stats[s];
    }

    inv(name: string = 'inv'): { slot: number; id: number; name: string; count: number }[] {
        const inv = this.player.getInventory(invId(name));
        if (!inv) return [];
        const out = [];
        for (let slot = 0; slot < inv.capacity; slot++) {
            const it = inv.get(slot);
            if (it) out.push({ slot, id: it.id, name: ObjType.get(it.id).debugname ?? String(it.id), count: it.count });
        }
        return out;
    }
    count(obj: number | string, inv: string = 'inv'): number {
        const id = toId(obj, objId);
        return this.inv(inv)
            .filter(i => i.id === id)
            .reduce((a, i) => a + i.count, 0);
    }
    worn() {
        return this.inv('worn');
    }

    varp(name: string | number): number {
        return this.player.getVar(toId(name, varpId)) as number;
    }
    varbit(name: string | number): number {
        return this.player.getVarBit(toId(name, varbitId));
    }

    get modalMain() {
        return this.player.modalMain;
    }
    get modalChat() {
        return this.player.modalChat;
    }
    get modalSide() {
        return this.player.modalSide;
    }
    get overlay() {
        return this.player.overlay;
    }

    lastMessages(n: number = 10) {
        return this.messages.slice(-n);
    }
    sawMessage(re: RegExp | string): boolean {
        return this.messages.some(m => (typeof re === 'string' ? m.includes(re) : re.test(m)));
    }
    clearMessages() {
        this.messages.length = 0;
        this.sent.length = 0;
    }

    myEvents(kind?: HarnessEvent['kind']) {
        return events.filter(e => e.who === 'player' && e.id === this.player.slot && (!kind || e.kind === kind));
    }

    /** True when not moving, no interaction target, no suspended script, not delayed. */
    get idle(): boolean {
        const p = this.player;
        return !p.hasWaypoints() && p.target === null && p.activeScript === null && !p.delayed;
    }

    // ---- setup helpers (bypass gameplay; tests only) ----

    teleport(x: number, z: number, level: number = 0): void {
        this.player.teleport(x, z, level);
    }
    give(obj: number | string, count: number = 1, inv: string = 'inv'): void {
        this.player.invAdd(invId(inv), toId(obj, objId), count);
    }
    clearInv(inv: string = 'inv'): void {
        this.player.getInventory(invId(inv))?.removeAll();
    }
    setLevel(s: PlayerStat, level: number): void {
        this.player.setLevel(s, level);
    }
    setVarp(name: string | number, value: number): void {
        this.player.setVar(toId(name, varpId), value);
    }
    setVarbit(name: string | number, value: number): void {
        this.player.setVarBit(toId(name, varbitId), value);
    }

    // ---- actions (client packets) ----

    private pathPacket(waypoints: ArrayLike<number>, opClick: boolean): MoveClick | null {
        if (waypoints.length === 0) return null;
        const path: { x: number; z: number }[] = [];
        for (let i = 0; i < waypoints.length && i < 25; i++) {
            const c = CoordGrid.unpackCoord(waypoints[i]);
            path.push({ x: c.x, z: c.z });
        }
        return new MoveClick(path, 0, opClick);
    }

    /** Click a tile (MOVE_GAMECLICK with a client-computed path). Does not wait. */
    clickTile(x: number, z: number): void {
        const pkt = this.pathPacket(findPath(this.level, this.x, this.z, x, z), false);
        if (pkt) this.send(ClientGameProt.MOVE_GAMECLICK, pkt);
    }

    /** Walk to a tile, re-clicking as needed, until arrived (or stuck). */
    walkTo(x: number, z: number, maxTicks: number = 300): void {
        const deadline = World.currentTick + maxTicks;
        let stuck = 0;
        while (!(this.x === x && this.z === z)) {
            if (World.currentTick > deadline) throw new Error(`walkTo(${x},${z}) timed out at ${this.x},${this.z}`);
            // the client pathfinder only searches its loaded area: click at most 60 tiles ahead
            const lx = this.x + Math.max(-60, Math.min(60, x - this.x));
            const lz = this.z + Math.max(-60, Math.min(60, z - this.z));
            const before = `${this.x},${this.z}`;
            this.clickTile(lx, lz);
            tick();
            tickUntil(() => !this.player.hasWaypoints(), maxTicks, 'walk');
            if (`${this.x},${this.z}` === before && ++stuck >= 2) {
                throw new Error(`walkTo(${x},${z}): stuck at ${before}`);
            }
        }
    }

    opHeld(op: number, obj: number | string): void {
        const id = toId(obj, objId);
        const it = this.inv().find(i => i.id === id);
        if (!it) throw new Error(`opHeld: no ${obj} in inventory`);
        this.send(ClientGameProt[`OPHELD${op}` as 'OPHELD1'], new OpHeld(op, id, it.slot, comId('inventory:inv')));
    }

    useHeldOnHeld(obj: number | string, onto: number | string): void {
        const a = this.inv().find(i => i.id === toId(obj, objId));
        const b = this.inv().find(i => i.id === toId(onto, objId) && i !== a);
        if (!a || !b) throw new Error('useHeldOnHeld: missing item');
        const inv = comId('inventory:inv');
        this.send(ClientGameProt.OPHELDU, new OpHeldU(b.id, b.slot, inv, a.id, a.slot, inv));
    }

    findLoc(type: number | string, radius: number = 15): Loc {
        const locs = locsNear(this.x, this.z, this.level, radius, type);
        if (locs.length === 0) throw new Error(`no loc ${type} near ${this.coord}`);
        locs.sort((a, b) => Math.max(Math.abs(a.x - this.x), Math.abs(a.z - this.z)) - Math.max(Math.abs(b.x - this.x), Math.abs(b.z - this.z)));
        return locs[0];
    }

    opLoc(op: number, loc: Loc): void {
        const lt = LocType.get(loc.type);
        const path = findPathToLoc(this.level, this.x, this.z, loc.x, loc.z, 1, loc.width, loc.length, loc.angle, loc.shape, lt.forceapproach);
        const pkt = this.pathPacket(path, true);
        if (pkt) this.send(ClientGameProt.MOVE_OPCLICK, pkt);
        this.send(ClientGameProt[`OPLOC${op}` as 'OPLOC1'], new OpLoc(op, loc.x, loc.z, loc.type));
    }

    useHeldOnLoc(obj: number | string, loc: Loc): void {
        const it = this.inv().find(i => i.id === toId(obj, objId));
        if (!it) throw new Error(`no ${obj}`);
        const lt = LocType.get(loc.type);
        const path = findPathToLoc(this.level, this.x, this.z, loc.x, loc.z, 1, loc.width, loc.length, loc.angle, loc.shape, lt.forceapproach);
        const pkt = this.pathPacket(path, true);
        if (pkt) this.send(ClientGameProt.MOVE_OPCLICK, pkt);
        this.send(ClientGameProt.OPLOCU, new OpLocU(loc.x, loc.z, loc.type, it.id, it.slot, comId('inventory:inv')));
    }

    /** Nearest npc of a type whose client path actually ends next to it (not stopped by a fence). */
    findNpc(type: number | string, radius: number = 15): Npc {
        const npcs = npcsNear(this.x, this.z, this.level, radius, type);
        if (npcs.length === 0) throw new Error(`no npc ${type} near ${this.coord}`);
        return npcs.find(n => this.canReach(n)) ?? npcs[0];
    }

    canReach(npc: Npc): boolean {
        const path = findPathToEntity(this.level, this.x, this.z, npc.x, npc.z, 1, npc.width, npc.length);
        const end = path.length === 0 ? { x: this.x, z: this.z } : CoordGrid.unpackCoord(path[path.length - 1]);
        return reachedEntity(this.level, end.x, end.z, npc.x, npc.z, npc.width, npc.length, 1);
    }

    opNpc(op: number, npc: Npc): void {
        const path = findPathToEntity(this.level, this.x, this.z, npc.x, npc.z, 1, npc.width, npc.length);
        const pkt = this.pathPacket(path, true);
        if (pkt) this.send(ClientGameProt.MOVE_OPCLICK, pkt);
        this.send(ClientGameProt[`OPNPC${op}` as 'OPNPC1'], new OpNpc(op, npc.nid));
    }

    useHeldOnNpc(obj: number | string, npc: Npc): void {
        const it = this.inv().find(i => i.id === toId(obj, objId));
        if (!it) throw new Error(`no ${obj}`);
        const path = findPathToEntity(this.level, this.x, this.z, npc.x, npc.z, 1, npc.width, npc.length);
        const pkt = this.pathPacket(path, true);
        if (pkt) this.send(ClientGameProt.MOVE_OPCLICK, pkt);
        this.send(ClientGameProt.OPNPCU, new OpNpcU(npc.nid, it.id, it.slot, comId('inventory:inv')));
    }

    opObj(op: number, obj: Obj): void {
        const path = this.x === obj.x && this.z === obj.z ? [] : findPath(this.level, this.x, this.z, obj.x, obj.z);
        const pkt = this.pathPacket(path, true);
        if (pkt) this.send(ClientGameProt.MOVE_OPCLICK, pkt);
        this.send(ClientGameProt[`OPOBJ${op}` as 'OPOBJ1'], new OpObj(op, obj.x, obj.z, obj.type));
    }

    ifButton(com: number | string): void {
        this.send(ClientGameProt.IF_BUTTON, new IfButton(toId(com, comId)));
    }
    invButton(op: number, com: number | string, obj: number | string, slot: number): void {
        this.send(ClientGameProt[`INV_BUTTON${op}` as 'INV_BUTTON1'], new InvButton(op, toId(obj, objId), slot, toId(com, comId)));
    }
    /** "Click here to continue" on a dialogue. */
    continueDialog(): void {
        this.send(ClientGameProt.RESUME_PAUSEBUTTON, new ResumePauseButton());
    }
    countDialog(n: number): void {
        this.send(ClientGameProt.RESUME_P_COUNTDIALOG, new ResumePCountDialog(n));
    }
    closeModal(): void {
        this.send(ClientGameProt.CLOSE_MODAL, new CloseModal());
    }
    cheat(cmd: string): void {
        this.send(ClientGameProt.CLIENT_CHEAT, new ClientCheat(cmd));
    }

    /** Pick a numbered option in a multi-choice dialogue (chat modal). Finds the nth option component. */
    chooseOption(n: number): void {
        const modal = this.player.modalChat;
        if (modal === -1) throw new Error('no chat modal open');
        const root = Component.get(modal);
        const name = root.comName ?? String(modal);
        // multi-choice interfaces are named multi2..multi5 with option components com_1..com_n in content
        this.ifButton(`${name}:com_${n}`);
    }

    /** Attack an npc (op2) and keep re-clicking until it dies. Returns ticks taken. */
    fight(npc: Npc, maxTicks: number = 300): number {
        const start = World.currentTick;
        this.opNpc(2, npc);
        tickUntil(
            () => {
                if (!npc.isActive || npcHp(npc) === 0) return true;
                if (this.player.target === null && !this.player.delayed && this.player.activeScript === null) this.opNpc(2, npc);
                return false;
            },
            maxTicks,
            `kill ${NpcType.get(npc.type).debugname}`
        );
        return World.currentTick - start;
    }

    /** Make the player strong enough for quick test fights. */
    makeStrong(): void {
        for (const s of [PlayerStat.ATTACK, PlayerStat.STRENGTH, PlayerStat.DEFENCE, PlayerStat.HITPOINTS, PlayerStat.PRAYER, PlayerStat.RANGED, PlayerStat.MAGIC]) {
            this.setLevel(s, 99);
        }
    }

    logout(): void {
        this.player.requestLogout = true;
    }

    /** Request logout and tick until removed from the world. Returns the saved bytes. */
    logoutAndWait(max: number = 60): Uint8Array {
        // the logout button is re-clicked each tick: a request blocked by the combat timer is dropped
        tickUntil(
            () => {
                if (this.player.isActive) this.logout();
                return !this.player.isActive;
            },
            max,
            `${this.player.username} logout`
        );
        Bot.all.delete(this);
        return this.player.save();
    }
}

export { World, Npc, Loc, Obj, ObjType, NpcType, LocType };
