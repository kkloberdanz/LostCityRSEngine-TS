// Barrows phase 5: tunnel door layout, the chest room puzzle, the Strange Old Man.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { boot, shutdown, tick, tickUntil, Bot, locsNear, comId, Loc } from '../Harness.js';

const LETTERS = 'abcdefghijklmnop';
// rooms 0 NW 1 N 2 NE 3 W 4 C 5 E 6 SW 7 S 8 SE
const EDGES: Record<string, [number, number]> = {
    a: [0, 2],
    b: [0, 6],
    h: [2, 8],
    p: [6, 8],
    d: [0, 1],
    f: [1, 2],
    g: [2, 5],
    m: [5, 8],
    o: [7, 8],
    n: [6, 7],
    k: [3, 6],
    c: [0, 3],
    e: [1, 4],
    i: [3, 4],
    j: [4, 5],
    l: [4, 7]
};
const CHEST_DOORS = ['e', 'i', 'j', 'l'];
const inChestRoom = (x: number, z: number) => x >= 3546 && x <= 3557 && z >= 9689 && z <= 9700;

let n = 0;
function newBot(at: [number, number, number] = [3565, 3290, 0]): Bot {
    const bot = Bot.login(`btun${n++}`, { at });
    bot.makeStrong();
    bot.immortal = true;
    return bot;
}
function done(bot: Bot) {
    bot.teleport(3565, 3310, 0);
    bot.logoutAndWait();
}

/** dig into the tunnel brother's crypt and take the tunnel */
function enterTunnels(bot: Bot) {
    bot.setVarp('barrows_tunnel', 1); // ahrim
    bot.teleport(3565, 3289, 0);
    tick();
    bot.give('spade');
    bot.opHeld(1, 'spade');
    tickUntil(() => bot.level === 3, 5, 'dig');
    bot.opLoc(1, bot.findLoc('barrow_ahrim_sarcophagus'));
    tickUntil(() => bot.modalChat !== -1, 10, 'tunnel message');
    bot.continueDialog();
    tickUntil(() => bot.modalChat === comId('multi2'), 5, 'choice');
    bot.chooseOption(1);
    tickUntil(() => bot.level === 0, 5, 'into the tunnels');
}

const locked = (bot: Bot) => Object.fromEntries([...LETTERS].map(c => [c, bot.varbit(`barrows_door_${c}`)]));

function reachableFrom(start: number, lk: Record<string, number>): Set<number> {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
        const r = stack.pop()!;
        for (const [c, [x, y]] of Object.entries(EDGES)) {
            if (lk[c]) continue;
            const other = x === r ? y : y === r ? x : -1;
            if (other >= 0 && !seen.has(other)) {
                seen.add(other);
                stack.push(other);
            }
        }
    }
    return seen;
}

/** the door of a chest room letter that sits against the chest room (the one you open to get in) */
function innerDoor(letter: string): Loc {
    const doors = [...locsNear(3551, 9695, 0, 12, `barrows_door_${letter}_l`), ...locsNear(3551, 9695, 0, 12, `barrows_door_${letter}_r`)];
    doors.sort((a, b) => Math.abs(a.x - 3551) + Math.abs(a.z - 9695) - (Math.abs(b.x - 3551) + Math.abs(b.z - 9695)));
    return doors[0];
}

before(async () => {
    await boot();
});
after(() => shutdown());

test('each run gets a door layout: one way into the chest room, every room still connected', () => {
    for (let run = 0; run < 15; run++) {
        const bot = newBot();
        enterTunnels(bot);
        const lk = locked(bot);
        assert.equal(CHEST_DOORS.filter(c => !lk[c]).length, 1, `one chest room door open: ${JSON.stringify(lk)}`);
        assert.equal(['c', 'd', 'f', 'g', 'k', 'm', 'n', 'o'].filter(c => lk[c]).length, 1, 'one ring door locked');
        assert.equal(reachableFrom(0, lk).size, 9, 'all nine rooms connected');
        done(bot);
    }
});

test('locked doors cannot be opened', () => {
    const bot = newBot();
    enterTunnels(bot);
    const lk = locked(bot);
    const shut = CHEST_DOORS.find(c => lk[c])!;
    const door = innerDoor(shut);
    bot.teleport(door.x, door.z, 0);
    tick();
    bot.opLoc(1, door);
    tick(5);
    assert.ok(!inChestRoom(bot.x, bot.z), 'still outside the chest room');
    done(bot);
});

test('the open chest room door asks the puzzle; the right answer lets you in, once per run', () => {
    const bot = newBot();
    enterTunnels(bot);
    const open = CHEST_DOORS.find(c => !locked(bot)[c])!;
    const door = innerDoor(open);
    bot.teleport(door.x, door.z, 0);
    tick();
    bot.opLoc(1, door);
    tickUntil(() => bot.modalMain === comId('inter_99'), 10, 'puzzle opens');
    assert.ok(bot.varbit('barrows_puzzle') >= 1 && bot.varbit('barrows_puzzle') <= 4);
    assert.ok(!inChestRoom(bot.x, bot.z));
    const answer = bot.varp('barrows_puzzle_answer');
    bot.ifButton(`inter_99:com_${5 + answer}`);
    tickUntil(() => inChestRoom(bot.x, bot.z), 5, 'into the chest room');
    assert.equal(bot.varbit('barrows_puzzle'), 7, 'solved');
    assert.equal(bot.modalMain, -1);

    // out and back in: no puzzle this time
    bot.teleport(door.x, door.z, 0);
    tick();
    bot.opLoc(1, door);
    tickUntil(() => inChestRoom(bot.x, bot.z), 10, 'straight back in');
    done(bot);
});

test('a wrong answer shifts the tunnels and moves the exit ladder', () => {
    const bot = newBot();
    enterTunnels(bot);
    const before = JSON.stringify(locked(bot));
    const open = CHEST_DOORS.find(c => !locked(bot)[c])!;
    const door = innerDoor(open);
    bot.teleport(door.x, door.z, 0);
    tick();
    bot.opLoc(1, door);
    tickUntil(() => bot.modalMain === comId('inter_99'), 10, 'puzzle opens');
    const wrong = bot.varp('barrows_puzzle_answer') === 1 ? 2 : 1;
    bot.ifButton(`inter_99:com_${5 + wrong}`);
    tickUntil(() => bot.sawMessage('You got the puzzle wrong!'), 5, 'wrong answer');
    assert.ok(!inChestRoom(bot.x, bot.z), 'not let in');
    assert.equal(bot.varbit('barrows_puzzle'), 0, 'a new puzzle next time');
    const ladders = ['a', 'c', 'g', 'i'].filter(c => bot.varbit(`barrows_chamber_${c}`) === 1);
    assert.equal(ladders.length, 1, 'one exit ladder');
    console.log(`layout before ${before}\nlayout after  ${JSON.stringify(locked(bot))}`);
    assert.equal(reachableFrom(0, locked(bot)).size, 9);
    done(bot);
});

test('the Strange Old Man talks, and sometimes hands over a crumbling tome', () => {
    const bot = newBot([3565, 3292, 0]);
    let book = false;
    for (let i = 0; i < 40 && !book; i++) {
        const man = bot.findNpc('barrows_oldman', 20);
        bot.opNpc(1, man);
        tickUntil(() => bot.modalChat !== -1, 30, 'old man speaks');
        // click through: continue, or take the first option
        for (let s = 0; s < 20 && bot.modalChat !== -1; s++) {
            if (bot.modalChat === comId('multi2')) bot.chooseOption(1);
            else bot.continueDialog();
            tick();
        }
        tick();
        book = bot.count('barrows_book_history') > 0;
    }
    assert.ok(book, 'got the tome at some point');
    done(bot);
});
