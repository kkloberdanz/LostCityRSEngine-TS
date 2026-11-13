// Phase 0 acceptance: log in a headless player, walk, dig, kill a chicken, pick up the drop, log out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { boot, shutdown, tick, tickUntil, Bot, locsNear, objsNear, npcHp, seqId, PlayerStat, World } from '../Harness.js';

before(async () => {
    await boot();
});
after(() => shutdown());

test('phase 0: walk, dig, kill a chicken, loot, logout', () => {
    const t0 = Date.now();
    const bot = Bot.login('harness0', { at: [3222, 3218, 0] });
    assert.ok(bot.online, 'logged in');
    assert.deepEqual(bot.coord, [3222, 3218, 0]);
    assert.ok(bot.sawMessage('Welcome to RuneScape'), 'login message');

    bot.setLevel(PlayerStat.ATTACK, 40);
    bot.setLevel(PlayerStat.STRENGTH, 40);
    bot.give('spade');

    // walk east over the bridge towards the chicken farm
    bot.walkTo(3236, 3226);
    assert.deepEqual(bot.coord, [3236, 3226, 0]);

    // dig
    bot.opHeld(1, 'spade');
    tickUntil(() => bot.myEvents('anim').some(e => e.value === seqId('human_dig')), 5, 'dig anim');

    // chicken pen north of Lumbridge (east farm): open the gate (oploc1) and step in
    bot.walkTo(3238, 3295);
    const gate = bot.findLoc('loc_1551', 3);
    bot.opLoc(1, gate);
    tickUntil(() => locsNear(3236, 3296, 0, 0, 'loc_1551').length === 0, 10, 'gate opens');
    bot.walkTo(3234, 3296);
    const chicken = bot.findNpc('chicken');
    assert.ok(bot.canReach(chicken), 'a reachable chicken');
    const xpBefore = bot.xp(PlayerStat.ATTACK) + bot.xp(PlayerStat.STRENGTH) + bot.xp(PlayerStat.DEFENCE);
    const deathX = () => chicken.x,
        deathZ = () => chicken.z;
    let lastX = chicken.x,
        lastZ = chicken.z;

    bot.opNpc(2, chicken);
    tickUntil(
        () => {
            if (chicken.isActive) {
                lastX = deathX();
                lastZ = deathZ();
            }
            return npcHp(chicken) === 0 || !chicken.isActive;
        },
        100,
        'chicken dies'
    );
    assert.ok(bot.myEvents('anim').length > 1, 'attack animations');
    const xpNow = () => bot.xp(PlayerStat.ATTACK) + bot.xp(PlayerStat.STRENGTH) + bot.xp(PlayerStat.DEFENCE);
    tickUntil(() => xpNow() > xpBefore, 5, `combat xp rises (was ${xpBefore})`);
    assert.ok(bot.xp(PlayerStat.HITPOINTS) > 1154, 'hitpoints xp rose');

    // a drop appears where it died (bones always)
    tickUntil(() => objsNear(lastX, lastZ, 0, 1, 'bones').length > 0, 10, 'bones drop');
    const bones = objsNear(lastX, lastZ, 0, 1, 'bones')[0];
    bot.opObj(3, bones);
    tickUntil(() => bot.count('bones') === 1, 20, 'pick up bones');

    const save = bot.logoutAndWait();
    assert.ok(!bot.online, 'logged out');
    assert.ok(save.length > 100, 'save produced');
    tick(2);
    console.log(`phase0 wall time ${Date.now() - t0} ms, world tick ${World.currentTick}`);
});
