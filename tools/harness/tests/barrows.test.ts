// Barrows phase 1: digging in, crypts, brothers, tunnels, doors, crypt monsters, chest and rewards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { boot, shutdown, tick, tickUntil, Bot, npcsNear, locsNear, npcHp, comId, objId, NpcStat, PlayerStat, Npc } from '../Harness.js';

const BROTHERS = ['ahrim', 'dharok', 'guthan', 'karil', 'torag', 'verac'] as const;
// OSRS map coordinates (checked walkable in this map)
const MOUND: Record<string, [number, number]> = { ahrim: [3565, 3289], dharok: [3575, 3298], guthan: [3577, 3282], karil: [3566, 3275], torag: [3553, 3283], verac: [3557, 3298] };
const CRYPT: Record<string, [number, number]> = { ahrim: [3557, 9703], dharok: [3556, 9718], guthan: [3534, 9704], karil: [3546, 9684], torag: [3568, 9683], verac: [3578, 9706] };
const CORNERS: [number, number][] = [
    [3535, 9712],
    [3567, 9712],
    [3535, 9678],
    [3567, 9678]
];
const CHEST: [number, number] = [3551, 9695];

let n = 0;
function newBot(at: [number, number, number]): Bot {
    const bot = Bot.login(`barrows${n++}`, { at });
    bot.makeStrong();
    bot.immortal = true;
    return bot;
}

/** leave the area (aggressive crypt monsters keep you in combat) and log out */
function done(bot: Bot): Uint8Array {
    bot.teleport(3565, 3310, 0);
    return bot.logoutAndWait();
}

function brotherFor(bot: Bot, name: string, radius = 15): Npc[] {
    return npcsNear(bot.x, bot.z, bot.level, radius, `barrows_${name}`);
}

/** speed up test fights: an unarmed player only hits a brother's 230+ defence ~10% of the time */
function weaken(npc: Npc) {
    npc.levels[NpcStat.HITPOINTS] = 10;
    npc.levels[NpcStat.DEFENCE] = 1;
}

/** dig on a mound, landing in its crypt */
function digInto(bot: Bot, name: string) {
    const [mx, mz] = MOUND[name];
    bot.teleport(mx, mz, 0);
    tick();
    bot.give('spade');
    bot.opHeld(1, 'spade');
    tickUntil(() => bot.level === 3, 5, `dig into ${name}`);
}

function search(bot: Bot, locName: string) {
    const loc = bot.findLoc(locName, 15);
    bot.opLoc(1, loc);
}

before(async () => {
    await boot();
});
after(() => shutdown());

test('digging on each mound lands in its crypt, and the stairs lead back up', () => {
    const bot = newBot([3565, 3290, 0]);
    for (const b of BROTHERS) {
        bot.clearMessages();
        digInto(bot, b);
        assert.deepEqual(bot.coord, [...CRYPT[b], 3], `${b} crypt`);
        assert.ok(bot.sawMessage("You've broken into a crypt!"), 'crypt message');
        assert.equal(bot.overlay, comId('inter_98'), 'kill count overlay open');

        const stairs = bot.findLoc(`barrows_stairs_${b}`, 5);
        bot.opLoc(1, stairs);
        tickUntil(() => bot.level === 0, 10, `${b} stairs up`);
        assert.deepEqual(bot.coord, [...MOUND[b], 0], `${b} mound`);
        assert.equal(bot.overlay, -1, 'overlay closed');
    }
    done(bot);
});

test('digging off the mounds does nothing special', () => {
    const bot = newBot([3565, 3300, 0]);
    bot.give('spade');
    bot.opHeld(1, 'spade');
    tick(3);
    assert.equal(bot.level, 0);
    done(bot);
});

test('searching a sarcophagus spawns its brother once; leaving the crypt despawns him', () => {
    const bot = newBot([3565, 3290, 0]);
    bot.setVarp('barrows_tunnel', 6); // verac hides the tunnel this run, so dharok is a normal crypt
    digInto(bot, 'dharok');
    search(bot, 'barrow_dharok_sarcophagus');
    tickUntil(() => brotherFor(bot, 'dharok').length === 1, 10, 'dharok appears');

    // he goes for the player who summoned him
    const dharok = brotherFor(bot, 'dharok')[0];
    tickUntil(() => dharok.target === bot.player, 5, 'dharok targets us');

    search(bot, 'barrow_dharok_sarcophagus');
    tick(5);
    assert.equal(brotherFor(bot, 'dharok').length, 1, 'only one dharok');

    const stairs = bot.findLoc('barrows_stairs_dharok', 10);
    bot.opLoc(1, stairs);
    tickUntil(() => bot.level === 0, 15, 'climb out');
    tickUntil(() => npcsNear(...CRYPT.dharok, 3, 20, 'barrows_dharok').length === 0, 10, 'dharok despawns');
    assert.equal(bot.varbit('barrows_killed_dharok'), 0);
    done(bot);
});

test('killing a brother sets his varbit and he does not come back this run', () => {
    const bot = newBot([3565, 3290, 0]);
    bot.setVarp('barrows_tunnel', 6);
    digInto(bot, 'torag');
    search(bot, 'barrow_torag_sarcophagus');
    tickUntil(() => brotherFor(bot, 'torag').length === 1, 10, 'torag appears');
    const torag = brotherFor(bot, 'torag')[0];
    assert.equal(npcHp(torag), 100, 'torag has 100 hp');
    weaken(torag);
    bot.fight(torag);
    tickUntil(() => bot.varbit('barrows_killed_torag') === 1, 5, 'torag kill recorded');
    assert.equal(bot.varbit('barrows_killed_monster'), 115, 'torag counts 115 towards reward potential');

    bot.clearMessages();
    search(bot, 'barrow_torag_sarcophagus');
    tickUntil(() => bot.sawMessage("You don't find anything."), 10, 'empty sarcophagus');
    tick(3);
    assert.equal(brotherFor(bot, 'torag').length, 0, 'no second torag');
    done(bot);
});

test('ahrim (magic) and karil (ranged) fight from range', () => {
    const bot = newBot([3565, 3290, 0]);
    bot.setVarp('barrows_tunnel', 6);
    for (const b of ['ahrim', 'karil']) {
        digInto(bot, b);
        bot.setVarp('barrows_tunnel', 6);
        search(bot, `barrow_${b}_sarcophagus`);
        tickUntil(() => brotherFor(bot, b).length === 1, 10, `${b} appears`);
        const dmgBefore = bot.myEvents('damage').length;
        tickUntil(() => bot.myEvents('damage').length > dmgBefore, 30, `${b} attacks`);
        const bro = brotherFor(bot, b)[0];
        weaken(bro);
        bot.fight(bro);
        tickUntil(() => bot.varbit(`barrows_killed_${b}`) === 1, 5, `${b} kill recorded`);
    }
    done(bot);
});

test('the tunnel brother sarcophagus leads into the tunnels; the ladder leads back', () => {
    const bot = newBot([3565, 3290, 0]);
    bot.setVarp('barrows_tunnel', 3); // guthan
    digInto(bot, 'guthan');
    search(bot, 'barrow_guthan_sarcophagus');
    tickUntil(() => bot.modalChat !== -1, 10, 'hidden tunnel message');
    bot.continueDialog();
    tickUntil(() => bot.modalChat === comId('multi2'), 5, 'choice');
    bot.chooseOption(1);
    tickUntil(() => bot.level === 0, 5, 'into the tunnels');
    const corner = CORNERS.findIndex(([x, z]) => x === bot.x && z === bot.z);
    assert.ok(corner >= 0, `arrived in a corner room, at ${bot.coord}`);
    const chamber = ['a', 'c', 'g', 'i'][corner];
    assert.equal(bot.varbit(`barrows_chamber_${chamber}`), 1, 'ladder shown in this room');
    assert.equal(brotherFor(bot, 'guthan', 40).length, 0, 'guthan does not spawn from his own sarcophagus');

    const ladder = bot.findLoc(`barrows_ladder_${chamber}`, 3);
    bot.opLoc(1, ladder);
    tickUntil(() => bot.level === 3, 10, 'climb the ladder');
    assert.deepEqual(bot.coord, [...CRYPT.guthan, 3]);
    assert.equal(bot.varbit(`barrows_chamber_${chamber}`), 0, 'ladder hidden again');
    assert.equal(bot.varp('barrows_tunnel'), 3, 'still the same tunnel brother mid-run');
    done(bot);
});

test('tunnel doors let you through in both directions', () => {
    const bot = newBot([3535, 9712, 0]);
    // door k at 3534,9688 / 3535,9688: wall on the north edge (angle 1) between room g (south) and the corridor
    const door = locsNear(3534, 9688, 0, 0, 'barrows_door_k_r')[0] ?? locsNear(3534, 9688, 0, 0, 'barrows_door_k_l')[0];
    assert.ok(door, 'door k found');
    bot.teleport(3534, 9690, 0);
    tick();
    const startSide = bot.z;
    bot.opLoc(1, door);
    tickUntil(() => (startSide > door.z ? bot.z <= door.z : bot.z > door.z), 15, 'through the door');
    const otherSide = bot.z;
    bot.opLoc(1, door);
    tickUntil(() => (otherSide > door.z ? bot.z <= door.z : bot.z > door.z), 15, 'back through the door');
    done(bot);
});

test('crypt monsters fight back and count towards the kill count', () => {
    const bot = newBot([3537, 9695, 0]);
    bot.setVarp('barrows_tunnel', 1);
    const kc0 = bot.varbit('barrows_killed_count');
    const rat = bot.findNpc('barrows_rat', 10);
    assert.equal(npcHp(rat), 35);
    bot.fight(rat);
    tickUntil(() => bot.varbit('barrows_killed_count') === kc0 + 1, 5, 'kill count +1');
    assert.equal(bot.varbit('barrows_killed_monster'), 43, 'crypt rat adds 43 reward potential');
    done(bot);
});

test('the chest summons the tunnel brother, then gives the reward and resets the run', () => {
    const bot = newBot([3565, 3290, 0]);
    bot.setVarp('barrows_tunnel', 2); // dharok
    bot.setVarbit('barrows_killed_ahrim', 1);
    bot.setVarbit('barrows_killed_karil', 1);
    bot.setVarbit('barrows_killed_monster', 600);
    bot.setVarbit('barrows_killed_count', 12);
    bot.teleport(CHEST[0], CHEST[1] - 2, 0);
    tick();
    bot.setLevel(PlayerStat.PRAYER, 99);
    const chest = bot.findLoc('barrows_stone_chest', 5);

    bot.opLoc(1, chest); // Open
    tickUntil(() => bot.varbit('barrows_chest_open') === 1, 15, 'chest opens');
    tickUntil(() => brotherFor(bot, 'dharok').length === 1, 5, 'dharok confronts you');
    const dharok = brotherFor(bot, 'dharok')[0];
    weaken(dharok);
    bot.fight(dharok);
    tickUntil(() => bot.varbit('barrows_killed_dharok') === 1, 5, 'dharok kill recorded');

    const before = bot.inv().length;
    bot.opLoc(1, chest); // Search
    tickUntil(() => bot.sawMessage('You find some treasure in the chest!'), 20, 'loot');
    assert.ok(bot.inv().length > before, `got loot: ${JSON.stringify(bot.inv().map(i => `${i.name} x${i.count}`))}`);
    assert.equal(bot.varp('barrows_kills'), 0, 'kills and kill count reset');
    assert.equal(bot.varp('barrows_looted'), 1);

    // looting again gives nothing
    bot.clearMessages();
    bot.opLoc(1, chest);
    tickUntil(() => bot.sawMessage('The chest is empty.') || bot.varbit('barrows_chest_open') === 1, 10, 'chest after loot');

    // the ceiling collapses on you
    const hp = bot.hp;
    tickUntil(() => bot.sawMessage('Some rocks fall from the ceiling'), 15, 'collapse');
    assert.ok(bot.hp <= hp);

    // leaving through a ladder ends the run
    bot.setVarbit('barrows_chamber_a', 1);
    bot.teleport(3535, 9712, 0);
    tick();
    bot.opLoc(1, bot.findLoc('barrows_ladder_a', 3));
    tickUntil(() => bot.level === 3, 10, 'ladder up');
    assert.deepEqual(bot.coord, [...CRYPT.dharok, 3], 'into the tunnel brother crypt');
    assert.equal(bot.varp('barrows'), 0, 'tunnel layout forgotten');
    assert.equal(bot.varp('barrows_tunnel'), 0, 'next run picks a new tunnel');
    assert.equal(bot.varp('barrows_looted'), 0);
    done(bot);
});

test('reward odds follow the OSRS formula (statistical, all six brothers, max potential)', async () => {
    // 1/(450 - 58*6) = 1/102 per roll, 7 rolls => P(at least one piece) ~ 6.6%
    const bot = newBot([CHEST[0], CHEST[1] - 2, 0]);
    let chests = 0;
    let pieces = 0;
    let runes = 0;
    for (let i = 0; i < Number(process.env.BARROWS_CHESTS ?? 300); i++) {
        bot.clearInv();
        bot.setVarp('barrows_looted', 0);
        bot.setVarp('barrows_tunnel', 1);
        for (const b of BROTHERS) bot.setVarbit(`barrows_killed_${b}`, 1);
        bot.setVarbit('barrows_killed_monster', 1000);
        bot.setVarbit('barrows_chest_open', 1);
        const chest = bot.findLoc('barrows_stone_chest', 5);
        bot.opLoc(1, chest);
        tickUntil(() => bot.varp('barrows_looted') === 1, 10, 'loot');
        chests++;
        const inv = bot.inv();
        if (inv.some(it => it.name.startsWith('barrows_') && it.name !== 'barrows_karil_ammo')) pieces++;
        if (inv.some(it => /rune$/.test(it.name))) runes++;
        assert.ok(inv.length >= 1 && inv.length <= 7, `1-7 items, got ${inv.length}`);
    }
    const rate = pieces / chests;
    console.log(`barrows piece in ${pieces}/${chests} chests (${(100 * rate).toFixed(1)}%, expected ~6.6%); runes in ${runes}`);
    assert.ok(rate > 0.01 && rate < 0.16, `piece rate ${rate}`);
    assert.ok(runes > chests * 0.5, 'max potential gives runes most of the time');
    done(bot);
});

test('prayer drains underground: 8 + brothers killed every 18 seconds', () => {
    const bot = newBot([3565, 3290, 0]);
    bot.setVarp('barrows_tunnel', 6);
    bot.setVarbit('barrows_killed_ahrim', 1);
    bot.setVarbit('barrows_killed_dharok', 1);
    digInto(bot, 'karil');
    const p0 = bot.stat(PlayerStat.PRAYER);
    tick(31);
    assert.equal(bot.stat(PlayerStat.PRAYER), p0 - 10, 'drained by 8 + 2');
    tick(30);
    assert.equal(bot.stat(PlayerStat.PRAYER), p0 - 20);
    // and stops on the surface
    bot.opLoc(1, bot.findLoc('barrows_stairs_karil', 10));
    tickUntil(() => bot.level === 0, 15, 'climb out');
    const p1 = bot.stat(PlayerStat.PRAYER);
    tick(35);
    assert.equal(bot.stat(PlayerStat.PRAYER), p1, 'no drain on the surface');
    done(bot);
});

test('logging in underground restores the overlay and drain', () => {
    const bot = newBot([3565, 3290, 0]);
    digInto(bot, 'verac');
    const save = bot.logoutAndWait(); // log out in the crypt
    const again = Bot.login(bot.player.username, { save });
    assert.equal(again.level, 3);
    assert.equal(again.overlay, comId('inter_98'));
    void objId;
    done(again);
});
