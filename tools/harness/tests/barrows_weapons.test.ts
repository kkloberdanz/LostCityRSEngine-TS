// Barrows phase 2: the five weapons that had no stats, and Karil's bolt racks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { boot, shutdown, tick, tickUntil, Bot, objsNear, seqId, PlayerStat } from '../Harness.js';

let n = 0;
function newBot(): Bot {
    const bot = Bot.login(`bweap${n++}`, { at: [3222, 3218, 0] });
    bot.makeStrong();
    bot.setLevel(PlayerStat.HITPOINTS, 99);
    bot.immortal = true;
    return bot;
}

function wield(bot: Bot, obj: string) {
    bot.give(obj);
    bot.opHeld(2, obj);
    tickUntil(() => bot.worn().some(w => w.name === obj), 3, `wield ${obj}`);
}

before(async () => {
    await boot();
});
after(() => shutdown());

const MELEE: [string, string, number][] = [
    // weapon, attack anim on the first (default) style, strength bonus
    ['barrows_dharok_weapon', 'barrow_dharok_slash', 105],
    ['barrows_guthan_weapon', 'barrows_war_spear_stab', 75],
    ['barrows_torag_weapon', 'barrow_torag_crush', 72],
    ['barrows_verac_weapon', 'barrow_guthan_crush', 72]
];

for (const [weapon, anim, str] of MELEE) {
    test(`${weapon}: wieldable at 70, has stats and its own attack animation`, () => {
        const bot = newBot();
        const unarmedMax = bot.varp('com_maxhit');
        wield(bot, weapon);
        tick();
        assert.ok(bot.varp('com_maxhit') > unarmedMax + 10, `max hit ${unarmedMax} -> ${bot.varp('com_maxhit')} (str bonus ${str})`);
        assert.equal(bot.varp('com_attackanim'), seqId(anim), 'attack animation');

        // and it hits things
        bot.teleport(3230, 3299, 0); // inside the Lumbridge chicken pen
        tick();
        const chicken = bot.findNpc('chicken');
        bot.fight(chicken);
        assert.ok(
            bot.myEvents('anim').some(e => e.value === seqId(anim)),
            'used its attack animation'
        );
        bot.logoutAndWait();
    });
}

test('barrows weapons need 70 Attack (and Dharok/Torag 70 Strength)', () => {
    const bot = Bot.login(`bweap${n++}`, { at: [3222, 3218, 0] });
    bot.setLevel(PlayerStat.ATTACK, 69);
    bot.setLevel(PlayerStat.STRENGTH, 99);
    for (const w of ['barrows_dharok_weapon', 'barrows_guthan_weapon', 'barrows_dharok_weapon_100']) {
        bot.give(w);
        bot.opHeld(2, w);
        tick(2);
        assert.ok(!bot.worn().some(x => x.name === w), `${w} not wielded at 69 attack`);
    }
    bot.setLevel(PlayerStat.ATTACK, 70);
    bot.setLevel(PlayerStat.STRENGTH, 69);
    bot.opHeld(2, 'barrows_dharok_weapon');
    tick(2);
    assert.ok(!bot.worn().some(x => x.name === 'barrows_dharok_weapon'), 'dharok needs 70 strength');
    bot.opHeld(2, 'barrows_guthan_weapon');
    tickUntil(() => bot.worn().some(x => x.name === 'barrows_guthan_weapon'), 3, 'guthan at 70 attack');
    bot.logoutAndWait();
});

test("karil's crossbow fires bolt racks, which break; it rejects other ammo", () => {
    const bot = newBot();
    wield(bot, 'barrows_karil_weapon');
    bot.give('barrows_karil_ammo', 50);
    bot.opHeld(2, 'barrows_karil_ammo');
    tickUntil(() => bot.count('barrows_karil_ammo', 'worn') === 50, 3, 'racks in quiver');
    assert.equal(bot.varp('com_attackanim'), seqId('barrows_repeating_crossbow_fire'));

    bot.teleport(3230, 3299, 0);
    tick();
    const chicken = bot.findNpc('chicken');
    const xp0 = bot.xp(PlayerStat.RANGED);
    bot.fight(chicken);
    tick(3);
    const used = 50 - bot.count('barrows_karil_ammo', 'worn');
    assert.ok(used >= 1, `racks used: ${used}`);
    assert.ok(bot.xp(PlayerStat.RANGED) > xp0, 'ranged xp');
    assert.equal(objsNear(bot.x, bot.z, 0, 12, 'barrows_karil_ammo').length, 0, 'no racks left on the ground');

    // normal bolts don't fit
    // swap the quiver for normal bolts
    bot.give('bolt', 20);
    bot.opHeld(2, 'bolt');
    tickUntil(() => bot.count('bolt', 'worn') === 20, 3, 'bolts in quiver');
    bot.clearMessages();
    const c2 = bot.findNpc('chicken');
    bot.opNpc(2, c2);
    tickUntil(() => bot.sawMessage("You can't use that ammo with your crossbow."), 20, 'rejects bolts');
    bot.logoutAndWait();
});

test('a normal crossbow will not fire bolt racks', () => {
    const bot = newBot();
    wield(bot, 'crossbow');
    bot.give('barrows_karil_ammo', 10);
    bot.opHeld(2, 'barrows_karil_ammo');
    tickUntil(() => bot.count('barrows_karil_ammo', 'worn') === 10, 3, 'racks in quiver');
    bot.teleport(3230, 3299, 0);
    tick();
    bot.clearMessages();
    bot.opNpc(2, bot.findNpc('chicken'));
    tickUntil(() => bot.sawMessage("You can't use that ammo with your crossbow."), 10, 'rejects racks');
    assert.equal(bot.count('barrows_karil_ammo', 'worn'), 10);
    bot.logoutAndWait();
});
