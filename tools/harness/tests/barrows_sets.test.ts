// Barrows phase 3: player set effects (PvM and PvP).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { boot, shutdown, tick, tickUntil, events, Bot, NpcStat, PlayerStat, World, Npc } from '../Harness.js';

let n = 0;
function newBot(at: [number, number, number] = [3230, 3299, 0]): Bot {
    const bot = Bot.login(`bset${n++}`, { at });
    bot.makeStrong();
    bot.setLevel(PlayerStat.AGILITY, 99);
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
/** walk away from the dummy (it keeps you in combat) and log out */
function done(bot: Bot) {
    bot.teleport(3222, 3218, 0);
    bot.logoutAndWait();
}
const set = (b: string) => ['head', 'body', 'legs', 'weapon'].map(p => `barrows_${b}_${p}`);

/** a chicken turned into a training dummy: lots of hp; defence as given */
function dummy(bot: Bot, defence = 1): Npc {
    const c = bot.findNpc('chicken');
    c.levels[NpcStat.HITPOINTS] = 2000;
    c.levels[NpcStat.DEFENCE] = defence;
    c.levels[NpcStat.STRENGTH] = 100;
    return c;
}

/** attack the npc for a number of ticks (re-clicking), keeping it alive; returns damage events dealt to it */
function pound(bot: Bot, npc: Npc, ticks: number, defence: number, attack: () => void = () => bot.opNpc(2, npc)) {
    const t0 = World.currentTick;
    attack();
    for (let i = 0; i < ticks; i++) {
        npc.levels[NpcStat.HITPOINTS] = 2000;
        npc.levels[NpcStat.DEFENCE] = defence;
        if (bot.player.target === null && bot.player.activeScript === null) attack();
        tick();
    }
    return events.filter(e => e.who === 'npc' && e.id === npc.nid && e.tick >= t0);
}

const hits = (evs: ReturnType<typeof pound>) => evs.filter(e => e.kind === 'damage').map(e => e.value as number);

before(async () => {
    await boot();
});
after(() => shutdown());

test('dharok: max hit grows as hitpoints drop', () => {
    const bot = newBot();
    wear(bot, set('dharok'));
    const normalMax = bot.varp('com_maxhit');
    const c = dummy(bot);

    bot.immortal = false;
    bot.holdHp = 99;
    const full = hits(pound(bot, c, 280, 1));
    bot.holdHp = 1;
    const low = hits(pound(bot, c, 280, 1));
    bot.holdHp = null;
    bot.immortal = true;

    const fullMax = Math.max(...full),
        lowMax = Math.max(...low);
    // at 1/99 hp: max * (1 + 98/100 * 99/100) = 1.97x
    console.log(`dharok: normal max ${normalMax}; seen max at full hp ${fullMax} (${full.length} hits), at 1 hp ${lowMax} (${low.length} hits)`);
    assert.ok(fullMax <= normalMax, 'no bonus at full hp');
    assert.ok(lowMax > normalMax, 'bonus at low hp');
    assert.ok(lowMax <= Math.floor(normalMax * 1.9702) + 1, 'bonus within the formula');
    done(bot);
});

test('verac: a quarter of hits ignore defence; three pieces do nothing', () => {
    const bot = newBot();
    wear(bot, set('verac').slice(0, 3)); // head, body, legs, no flail
    wear(bot, ['barrows_dharok_weapon']);
    // 65535 defence: a normal hit roll still lands ~0.3% of the time
    const c = dummy(bot, 65535);
    const partial = hits(pound(bot, c, 400, 65535)).filter(d => d > 0);
    assert.ok(partial.length <= 2, `almost no damage through 65535 defence without the full set (${partial.length})`);

    wear(bot, ['barrows_verac_weapon']);
    const ev = pound(bot, c, 400, 65535);
    const attacks = bot.myEvents('anim').filter(e => e.label === 'barrow_guthan_crush' && e.tick >= ev[0]?.tick - 1).length;
    const landed = hits(ev).filter(d => d > 0).length;
    console.log(`verac: ${landed} damaging hits out of ~${attacks} attacks through 65535 defence`);
    assert.ok(landed >= 5 && landed > partial.length * 4, `hits land with the set: ${landed} vs ${partial.length}`);
    assert.ok(landed < attacks * 0.5, 'but only about a quarter');
    done(bot);
});

test('guthan: hits heal you', () => {
    const bot = newBot();
    wear(bot, set('guthan'));
    bot.immortal = false;
    bot.player.levels[PlayerStat.HITPOINTS] = 40;
    const c = dummy(bot);
    const ev = pound(bot, c, 200, 1);
    const effects = ev.filter(e => e.kind === 'spotanim' && e.label === 'barrows_guthan_effect').length;
    console.log(`guthan: ${effects} heals, hp 40 -> ${bot.hp}`);
    assert.ok(effects > 0, 'effect fired');
    assert.ok(bot.hp > 50, 'healed well beyond natural regeneration');
    assert.ok(bot.hp <= 99, 'never above max');
    bot.immortal = true;
    done(bot);
});

test('torag and karil show their effect on npcs; ahrim lowers npc strength', () => {
    const bot = newBot();
    wear(bot, set('torag'));
    const c = dummy(bot);
    assert.ok(
        pound(bot, c, 200, 1).some(e => e.label === 'barrows_torag_effect'),
        'torag effect'
    );

    for (const it of set('karil')) bot.give(it);
    for (const it of set('karil')) bot.opHeld(2, it);
    tick(2);
    bot.give('barrows_karil_ammo', 500);
    bot.opHeld(2, 'barrows_karil_ammo');
    tickUntil(() => bot.count('barrows_karil_ammo', 'worn') > 0, 3, 'racks');
    assert.ok(
        pound(bot, c, 200, 1).some(e => e.label === 'barrows_karil_tainted_shot'),
        'karil effect'
    );

    for (const it of set('ahrim')) bot.give(it);
    for (const it of set('ahrim')) bot.opHeld(2, it);
    tick(2);
    bot.give('airrune', 1000);
    bot.give('mindrune', 1000);
    const str0 = 100;
    const ev = pound(bot, c, 300, 1, () => bot.spellOnNpc('magic:wind_strike', c));
    const auras = ev.filter(e => e.label === 'barrows_ahirm_blighted_aura').length;
    console.log(`ahrim: ${auras} blighted auras, npc strength now ${c.levels[NpcStat.STRENGTH]}`);
    assert.ok(auras > 0, 'ahrim effect');
    assert.ok(c.levels[NpcStat.STRENGTH] < str0, 'strength lowered');
    done(bot);
});

test('pvp: torag drains run energy, karil lowers agility', () => {
    // level 3 wilderness north of Edgeville
    const a = newBot([3090, 3540, 0]);
    const b = newBot([3092, 3540, 0]);
    wear(a, set('torag'));
    b.player.runenergy = 10000;
    let drained = false;
    a.opPlayer(2, b);
    for (let i = 0; i < 250 && !drained; i++) {
        tick();
        if (b.player.runenergy <= 8000) drained = true;
        b.player.runenergy = Math.max(b.player.runenergy, 9000); // stop running out
        if (a.player.target === null) a.opPlayer(2, b);
    }
    assert.ok(drained, 'torag drained run energy');

    for (const it of set('karil')) a.give(it);
    for (const it of set('karil')) a.opHeld(2, it);
    tick(2);
    a.give('barrows_karil_ammo', 500);
    a.opHeld(2, 'barrows_karil_ammo');
    tick(2);
    a.opPlayer(2, b);
    tickUntil(
        () => {
            if (a.player.target === null) a.opPlayer(2, b);
            return b.stat(PlayerStat.AGILITY) < 99;
        },
        300,
        'agility drained'
    );
    assert.equal(b.stat(PlayerStat.AGILITY), 99 - Math.floor(99 * 0.2), 'agility -20%');
    done(a);
    done(b);
});
