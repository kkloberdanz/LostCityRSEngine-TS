// Barrows phase 4: degradation in combat, and repair with Bob.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { boot, shutdown, tick, tickUntil, Bot, NpcStat, Npc, invId, objId } from '../Harness.js';

const BROTHERS = ['ahrim', 'dharok', 'guthan', 'karil', 'torag', 'verac'];
const SLOTS = ['head', 'body', 'legs', 'weapon'];
/** piece index 0-23 */
const piece = (b: string, slot: string) => BROTHERS.indexOf(b) * 4 + SLOTS.indexOf(slot);

function used(bot: Bot, p: number): number {
    return (bot.varp(`barrows_deg${Math.floor(p / 3)}`) >>> ((p % 3) * 10)) & 1023;
}
function setUsed(bot: Bot, p: number, v: number) {
    const name = `barrows_deg${Math.floor(p / 3)}`;
    const o = (p % 3) * 10;
    bot.setVarp(name, (bot.varp(name) & ~(1023 << o)) | (v << o));
}

let n = 0;
function newBot(at: [number, number, number] = [3230, 3299, 0]): Bot {
    const bot = Bot.login(`bdeg${n++}`, { at });
    bot.makeStrong();
    bot.immortal = true;
    return bot;
}
function wear(bot: Bot, items: string[]) {
    for (const it of items) {
        bot.give(it);
        bot.opHeld(2, it);
        tickUntil(() => bot.worn().some(w => w.name === it), 3, `wear ${it}`);
    }
}
const wornName = (bot: Bot, prefix: string) => bot.worn().find(w => w.name.startsWith(prefix))?.name;

/** keep fighting a 2000 hp chicken for some ticks */
function fightFor(bot: Bot, ticks: number, c?: Npc): Npc {
    c ??= bot.findNpc('chicken');
    for (let i = 0; i < ticks; i++) {
        c.levels[NpcStat.HITPOINTS] = 2000;
        if (bot.player.target === null && bot.player.activeScript === null) bot.opNpc(2, c);
        tick();
    }
    return c;
}
function done(bot: Bot) {
    bot.teleport(3222, 3218, 0);
    bot.logoutAndWait();
}

before(async () => {
    await boot();
});
after(() => shutdown());

test('a fresh piece becomes "100" on first use and loses a point per 90 ticks of combat', () => {
    const bot = newBot();
    wear(bot, ['barrows_dharok_head', 'barrows_dharok_weapon']);
    const ph = piece('dharok', 'head'),
        pw = piece('dharok', 'weapon');
    assert.equal(used(bot, ph), 0);

    const c = fightFor(bot, 3);
    assert.equal(wornName(bot, 'barrows_dharok_head'), 'barrows_dharok_head_100', 'helm is now 100');
    assert.equal(wornName(bot, 'barrows_dharok_weapon'), 'barrows_dharok_weapon_100', 'axe is now 100');
    assert.equal(used(bot, ph), 1, 'one point when combat starts');
    assert.equal(used(bot, pw), 1);

    fightFor(bot, 92, c);
    assert.equal(used(bot, ph), 2, 'one more after 90 ticks in combat');
    fightFor(bot, 90, c);
    assert.equal(used(bot, ph), 3);

    // leave combat: the period you were fighting in still costs its point, then nothing more while idle
    bot.teleport(3222, 3218, 0);
    tick(200);
    const after = used(bot, ph);
    assert.ok(after === 3 || after === 4, `at most one more point (${after})`);
    tick(300);
    assert.equal(used(bot, ph), after, 'no degradation out of combat');
    assert.equal(bot.varp('barrows_degrade_clock'), 0);
    done(bot);
});

test('pieces step down 100 -> 75 -> ... and break while worn, keeping no stats', () => {
    const bot = newBot();
    wear(bot, ['barrows_guthan_body_100', 'barrows_guthan_weapon_100']);
    const pb = piece('guthan', 'body');
    setUsed(bot, pb, 249);
    setUsed(bot, piece('guthan', 'weapon'), 999 - 250 * 3); // 249
    const c = fightFor(bot, 3);
    assert.equal(wornName(bot, 'barrows_guthan_body'), 'barrows_guthan_body_75');
    assert.equal(used(bot, pb), 250);

    // jump the counter to the end of the 25 stage
    bot.teleport(3222, 3218, 0);
    tick(200); // combat period ends
    setUsed(bot, pb, 999);
    // make the worn piece the 25 stage
    const worn = bot.player.getInventory(invId('worn'))!;
    const slot = bot.worn().find(w => w.name === 'barrows_guthan_body_75')!.slot;
    worn.set(slot, { id: objId('barrows_guthan_body_25'), count: 1 });
    assert.equal(wornName(bot, 'barrows_guthan_body'), 'barrows_guthan_body_25');
    bot.teleport(3230, 3299, 0);
    tick();
    fightFor(bot, 3, c);
    assert.equal(wornName(bot, 'barrows_guthan_body'), 'barrows_guthan_body_broken', 'broken, still worn');
    assert.ok(bot.sawMessage('has broken'), 'break message');
    done(bot);
});

test('broken pieces cannot be worn again', () => {
    const bot = newBot([3222, 3218, 0]);
    bot.give('barrows_torag_legs_broken');
    bot.opHeld(2, 'barrows_torag_legs_broken');
    tick(2);
    assert.ok(!bot.worn().some(w => w.name === 'barrows_torag_legs_broken'));
    done(bot);
});

test('Bob repairs barrows pieces for the OSRS prices', () => {
    const bot = newBot([3230, 3203, 0]);
    const bob = bot.findNpc('bob', 15);

    // broken helm: 60,000
    bot.give('barrows_verac_head_broken');
    bot.give('coins', 100000);
    bot.useHeldOnNpc('barrows_verac_head_broken', bob);
    tickUntil(() => bot.modalChat !== -1, 20, 'bob speaks');
    bot.continueDialog();
    tickUntil(() => bot.modalChat === bot.player.modalChat && bot.modalChat !== -1, 5, 'choice');
    tick();
    bot.chooseOption(1);
    tickUntil(() => bot.count('barrows_verac_head') === 1, 5, 'fresh helm back');
    assert.equal(bot.count('coins'), 40000, 'paid 60,000');
    assert.equal(bot.count('barrows_verac_head_broken'), 0);

    // legs at "50" with 600 points used: 600 * 80 = 48,000
    bot.give('barrows_verac_legs_50');
    setUsed(bot, piece('verac', 'legs'), 600);
    bot.give('coins', 8000); // 48,000 total
    bot.useHeldOnNpc('barrows_verac_legs_50', bob);
    tickUntil(() => bot.modalChat !== -1, 20, 'bob speaks');
    bot.continueDialog();
    tick(2);
    bot.chooseOption(1);
    tickUntil(() => bot.count('barrows_verac_legs') === 1, 5, 'fresh legs back');
    assert.equal(bot.count('coins'), 0, 'paid 48,000');
    assert.equal(used(bot, piece('verac', 'legs')), 0, 'counter reset');

    // not enough money
    bot.give('barrows_verac_weapon_broken');
    bot.useHeldOnNpc('barrows_verac_weapon_broken', bob);
    tickUntil(() => bot.modalChat !== -1, 20, 'bob speaks');
    assert.equal(bot.count('barrows_verac_weapon_broken'), 1, 'kept');
    done(bot);
});
