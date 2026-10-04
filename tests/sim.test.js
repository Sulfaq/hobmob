// Runs the game simulation from index.html in Node, without a browser.
// Usage: node tests/sim.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = html.match(/<script id="sim">([\s\S]*?)<\/script>/)[1];
const { Sim, CONFIG, RECIPES, EVENTS, SHOP, SaveCode, ITEMS, VENUES } = vm.runInNewContext(src + '\n;({ Sim, CONFIG, RECIPES, EVENTS, SHOP, SaveCode, ITEMS, VENUES })', {
  CompressionStream, DecompressionStream, Response, Blob, TextEncoder, TextDecoder, btoa, atob,
});

const DT = 1 / CONFIG.tickRate;
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 8).join('\n       ')}`); }
}

// ---- helpers: a bot that drives a player purely through inputs -------------
function newGame() {
  const g = Sim.createGame({ seed: 1 });
  const p = Sim.addPlayer(g, 'bot', 'Bot', 0);
  Sim.finishBuild(g);            // skip kitchen setup: these tests start at prep
  return { g, p };
}
function tick(g, p, input, n = 1) {
  for (let i = 0; i < n; i++) {
    Sim.setInput(g, p.id, Object.assign({ mx: 0, my: 0, grabSeq: p.input.grabSeq, use: false }, input));
    Sim.step(g, DT);
  }
}
function waitSeconds(g, p, s) { tick(g, p, {}, Math.ceil(s / DT)); }
function press(g, p) { tick(g, p, { grabSeq: p.input.grabSeq + 1 }); }
function hold(g, p, s) { tick(g, p, { use: true }, Math.ceil(s / DT)); }
const find = (g, type, pred = () => true) => g.stations.find(s => s.type === type && pred(s));
// Arrays made inside the vm sandbox have a different prototype, so compare as JSON.
const sameParts = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));

// BFS over floor tiles to a tile next to the station, then steer with move inputs.
function walkTo(g, p, st) {
  const key = (x, y) => y * g.w + x;
  const start = [Math.floor(p.x), Math.floor(p.y)];
  const goals = new Set();
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    if (!Sim.isSolid(g, st.x + dx, st.y + dy)) goals.add(key(st.x + dx, st.y + dy));
  }
  const from = new Map([[key(...start), null]]);
  const queue = [start];
  let end = null;
  while (queue.length) {
    const [x, y] = queue.shift();
    if (goals.has(key(x, y))) { end = [x, y]; break; }
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (Sim.isSolid(g, nx, ny) || from.has(key(nx, ny))) continue;
      from.set(key(nx, ny), [x, y]);
      queue.push([nx, ny]);
    }
  }
  assert(end, `no path to ${st.type} at ${st.x},${st.y}`);
  const pathTiles = [];
  for (let c = end; c; c = from.get(key(...c))) pathTiles.unshift(c);
  for (const [tx, ty] of pathTiles) {
    for (let guard = 0; guard < 200; guard++) {
      const dx = tx + 0.5 - p.x, dy = ty + 0.5 - p.y;
      if (Math.hypot(dx, dy) < 0.08) break;
      const d = Math.hypot(dx, dy), k = Math.min(1, d / (CONFIG.playerSpeed * DT));
      tick(g, p, { mx: (dx / d) * k, my: (dy / d) * k });
      assert(guard < 199, `stuck walking to ${tx},${ty}`);
    }
  }
  // Turn to face the station by pushing into it (collision stops us).
  tick(g, p, { mx: st.x + 0.5 - p.x, my: st.y + 0.5 - p.y }, 3);
  assert.strictEqual(p.target, st.id, `should be targeting ${st.type} at ${st.x},${st.y}`);
}

// ---- tests ------------------------------------------------------------------
console.log('Hob Mob simulation tests');

test('map builds with every station type', () => {
  const { g } = newGame();
  assert.strictEqual(g.w, 20); assert.strictEqual(g.h, 12);
  for (const t of ['counter', 'table', 'hob', 'board', 'sink', 'rack', 'bin', 'crate']) {
    assert(find(g, t), `missing ${t}`);
  }
  assert.strictEqual(g.stations.filter(s => s.type === 'table').length, 6);
});

test('walls block movement', () => {
  const { g, p } = newGame();
  tick(g, p, { mx: -1 }, 120);
  tick(g, p, { my: -1 }, 120);
  assert(p.x >= 1 + CONFIG.playerRadius - 1e-6, `x went into wall: ${p.x}`);
  assert(p.y >= 2 + CONFIG.playerRadius - 1e-6, `y went into crate row: ${p.y}`);
});

test('every station is reachable on foot', () => {
  const { g, p } = newGame();
  for (const s of g.stations) walkTo(g, p, s);
});

test('make a burger from scratch, entirely through inputs', () => {
  const { g, p } = newGame();
  const hob = find(g, 'hob');
  walkTo(g, p, find(g, 'crate', s => s.crateItem === 'patty')); press(g, p);
  assert.strictEqual(p.held.k, 'patty');
  walkTo(g, p, hob); press(g, p);
  assert.strictEqual(p.held, null); assert.strictEqual(hob.item.k, 'patty');

  // While it cooks: bun onto a counter, then a plate from the rack, then plate the bun.
  const counter = find(g, 'counter', s => s.y === 4);
  walkTo(g, p, find(g, 'crate', s => s.crateItem === 'bun')); press(g, p);
  walkTo(g, p, counter); press(g, p);
  assert.strictEqual(counter.item.k, 'bun');
  walkTo(g, p, find(g, 'rack')); press(g, p);
  assert.strictEqual(p.held.k, 'plate');
  walkTo(g, p, counter); press(g, p);
  sameParts(p.held.parts, ['bun']);
  assert.strictEqual(counter.item, null);

  walkTo(g, p, hob);
  waitSeconds(g, p, Math.max(0, CONFIG.cookTime - (hob.item.cook || 0)) + 0.2);
  assert.strictEqual(hob.item.k, 'cookedPatty');
  press(g, p);
  assert.strictEqual(hob.item, null);
  assert.strictEqual(Sim.dishOf(p.held), 'burger');
  assert(Sim.drainEvents(g).some(e => e.type === 'dish' && e.dish === 'burger'));
});

test('a patty left on the hob burns', () => {
  const { g, p } = newGame();
  const hob = find(g, 'hob');
  walkTo(g, p, find(g, 'crate', s => s.crateItem === 'patty')); press(g, p);
  walkTo(g, p, hob); press(g, p);
  waitSeconds(g, p, CONFIG.cookTime + CONFIG.burnTime + 0.2);
  assert.strictEqual(hob.item.k, 'burntPatty');
  press(g, p); // pick it up
  walkTo(g, p, find(g, 'bin')); press(g, p);
  assert.strictEqual(p.held, null);
});

test('hob refuses things that are not patties', () => {
  const { g, p } = newGame();
  walkTo(g, p, find(g, 'crate', s => s.crateItem === 'bun')); press(g, p);
  walkTo(g, p, find(g, 'hob')); press(g, p);
  assert.strictEqual(p.held.k, 'bun');
});

test('chopping needs USE held for chopTime', () => {
  const { g, p } = newGame();
  const board = find(g, 'board');
  walkTo(g, p, find(g, 'crate', s => s.crateItem === 'tomato')); press(g, p);
  walkTo(g, p, board); press(g, p);
  hold(g, p, CONFIG.chopTime / 2);
  assert.strictEqual(board.item.k, 'tomato');
  hold(g, p, CONFIG.chopTime / 2 + 0.1);
  assert.strictEqual(board.item.k, 'choppedTomato');
});

test('raw ingredients cannot go on a plate; plated food can be binned', () => {
  const { g, p } = newGame();
  const counter = find(g, 'counter', s => s.y === 4);
  walkTo(g, p, find(g, 'rack')); press(g, p);
  walkTo(g, p, counter); press(g, p);                     // plate on counter
  walkTo(g, p, find(g, 'crate', s => s.crateItem === 'lettuce')); press(g, p);
  walkTo(g, p, counter); press(g, p);                     // raw lettuce: refused
  assert.strictEqual(p.held.k, 'lettuce');
  sameParts(counter.item.parts, []);
  walkTo(g, p, find(g, 'crate', s => s.crateItem === 'lettuce')); press(g, p); // put it back
  assert.strictEqual(p.held, null);
  walkTo(g, p, counter); press(g, p);                     // pick up plate
  walkTo(g, p, find(g, 'crate', s => s.crateItem === 'bun')); press(g, p);     // bun straight onto plate
  sameParts(p.held.parts, ['bun']);
  walkTo(g, p, find(g, 'bin')); press(g, p);
  assert.strictEqual(p.held.k, 'plate');
  sameParts(p.held.parts, []);
});

test('dirty plates wash into clean plates at the sink', () => {
  const { g, p } = newGame();
  Sim.seedPractice(g);
  const table = g.stations.find(s => s.type === 'table' && s.item);
  const sink = find(g, 'sink');
  walkTo(g, p, table); press(g, p);
  assert.strictEqual(p.held.k, 'dirtyPlate');
  walkTo(g, p, sink); press(g, p);
  assert.strictEqual(sink.dirty, 1);
  hold(g, p, CONFIG.washTime + 0.1);
  assert.strictEqual(sink.dirty, 0); assert.strictEqual(sink.clean, 1);
  press(g, p);
  assert.strictEqual(p.held.k, 'plate');
});

test('plate rack refills over time up to its limit', () => {
  const { g, p } = newGame();
  const rack = find(g, 'rack');
  walkTo(g, p, rack);
  // It refills while we walk, so keep emptying it until it is bare.
  for (let guard = 0; rack.plates > 0; guard++) {
    assert(guard < 10, 'could not empty the rack');
    press(g, p); assert.strictEqual(p.held.k, 'plate');
    walkTo(g, p, find(g, 'bin')); press(g, p);  // bin refuses an empty plate…
    assert.strictEqual(p.held.k, 'plate');
    walkTo(g, p, find(g, 'counter', s => s.y === 10 && !s.item)); press(g, p); // …so park it
    walkTo(g, p, rack);
  }
  waitSeconds(g, p, CONFIG.plateRackInterval * (CONFIG.plateRackMax + 2));
  assert.strictEqual(rack.plates, CONFIG.plateRackMax);
});

test('state survives a JSON round trip (ready for network snapshots)', () => {
  const { g, p } = newGame();
  walkTo(g, p, find(g, 'crate', s => s.crateItem === 'patty')); press(g, p);
  const copy = JSON.parse(JSON.stringify(g));
  assert.deepStrictEqual(copy.players.bot.held, { k: 'patty' });
  Sim.step(copy, DT);
});

// ---- milestone 2: customers and the day loop ----------------------------------
const burgerPlate = () => ({ k: 'plate', parts: ['bun', 'cookedPatty'] });
const tableOf = (g, c) => g.stations[c.table];
function untilState(g, p, c, state, maxSeconds = 30) {
  for (let i = 0; i < maxSeconds / DT && c.state !== state; i++) tick(g, p, {});
  assert.strictEqual(c.state, state);
}

test('no customers during prep; they arrive after the doors open', () => {
  const { g, p } = newGame();
  assert.strictEqual(g.phase, 'prep');
  waitSeconds(g, p, CONFIG.prepTime - 1);
  assert.strictEqual(g.customers.length, 0);
  waitSeconds(g, p, 1.1 + CONFIG.firstArrivalDelay + 0.1);
  assert.strictEqual(g.phase, 'service');
  assert.strictEqual(g.customers.length, 1);
});

test('serving the right dish pays, then leaves a dirty plate that blocks the table', () => {
  const { g, p } = newGame();
  Sim.openDoors(g); g.day.nextArrival = Infinity; // only the customers we spawn
  const c = Sim.spawnCustomer(g);
  untilState(g, p, c, 'waiting');
  const table = tableOf(g, c);
  p.held = burgerPlate();
  walkTo(g, p, table); press(g, p);
  assert.strictEqual(c.state, 'eating');
  assert.strictEqual(p.held, null);
  assert(g.money >= RECIPES.burger.price, `money ${g.money}`);
  untilState(g, p, c, 'leaving');
  assert.strictEqual(table.item.k, 'dirtyPlate');
  waitSeconds(g, p, 10);
  assert(!g.customers.includes(c), 'customer should have left');

  // Fill the other five tables; the sixth customer has to queue.
  const others = [1, 2, 3, 4, 5, 6].map(() => Sim.spawnCustomer(g));
  tick(g, p, {});
  assert(others.slice(0, 5).every(o => o.table >= 0 && o.table !== table.id));
  assert.strictEqual(others[5].state, 'queue');
  // Clearing the plate frees the table for the queue.
  press(g, p);
  assert.strictEqual(p.held.k, 'dirtyPlate');
  tick(g, p, {});
  assert.strictEqual(others[5].table, table.id);
});

test('the wrong dish is refused', () => {
  const { g, p } = newGame();
  Sim.openDoors(g); g.day.nextArrival = Infinity; // only the customers we spawn
  const c = Sim.spawnCustomer(g);
  untilState(g, p, c, 'waiting');
  p.held = { k: 'plate', parts: ['bun'] };
  walkTo(g, p, tableOf(g, c)); press(g, p);
  assert.strictEqual(c.state, 'waiting');
  assert.strictEqual(p.held.k, 'plate');
  assert.strictEqual(g.day.stats.wrong, 1);
});

test('impatient customers storm out and cost reputation', () => {
  const { g, p } = newGame();
  Sim.openDoors(g); g.day.nextArrival = Infinity; // only the customers we spawn
  const c = Sim.spawnCustomer(g);
  untilState(g, p, c, 'waiting');
  waitSeconds(g, p, CONFIG.patience + 0.2);
  assert(c.angry);
  assert.strictEqual(g.reputation, CONFIG.startReputation - CONFIG.walkoutPenalty);
  assert.strictEqual(g.day.stats.walkouts, 1);
});

test('a neglected restaurant hits 0 stars and closes down', () => {
  const { g, p } = newGame();
  Sim.openDoors(g);
  const maxTicks = (CONFIG.dayLength + 200) / DT;
  for (let i = 0; i < maxTicks && g.phase !== 'gameover'; i++) tick(g, p, {});
  assert.strictEqual(g.phase, 'gameover');
  assert.strictEqual(g.reputation, 0);
  const s = g.summary;
  assert.strictEqual(s.walkouts, CONFIG.startReputation / CONFIG.walkoutPenalty);
  assert.strictEqual(s.backTo, 1);
  const frozen = g.tick; tick(g, p, { mx: 1 }, 10);
  assert.strictEqual(g.tick, frozen, 'sim should be paused on game over');
  Sim.restoreCheckpoint(g);
  assert.strictEqual(g.phase, 'build'); assert.strictEqual(g.dayNum, 1);
  assert.strictEqual(g.reputation, CONFIG.startReputation); assert.strictEqual(g.money, CONFIG.startMoney);
  assert.strictEqual(g.customers.length, 0);
});

test('serving everyone gives a great day and a bonus half star', () => {
  const { g, p } = newGame();
  const maxTicks = (CONFIG.prepTime + CONFIG.dayLength + 300) / DT;
  for (let i = 0; i < maxTicks && g.phase !== 'summary'; i++) {
    const c = g.customers.find(c => c.state === 'waiting');
    const dirty = g.stations.find(st => st.type === 'table' && st.item && st.item.k === 'dirtyPlate');
    if (c) {
      p.held = burgerPlate();                  // food appears by magic; delivery is real
      walkTo(g, p, tableOf(g, c)); press(g, p);
    } else if (dirty) {
      walkTo(g, p, dirty); press(g, p);
      p.held = null;
    } else tick(g, p, {});
  }
  const s = g.summary;
  assert(s, 'day should end');
  assert(s.served >= CONFIG.greatDayMinServed, `served ${s.served}`);
  assert.strictEqual(s.walkouts, 0);
  assert.strictEqual(s.served, s.arrivals);
  assert(s.great);
  assert.strictEqual(g.reputation, CONFIG.startReputation + CONFIG.greatDayBonus);
  assert(s.tips > 0);
  // The next day starts fresh, and the upgrade vote decided something.
  assert.strictEqual(g.offer.length, CONFIG.upgradeChoices);
  const frozen = g.tick; tick(g, p, { mx: 1 }, 10);
  assert.strictEqual(g.tick, frozen, 'sim should be paused on the summary');
  Sim.nextDay(g, 'bot');
  assert.strictEqual(g.dayNum, 2); assert.strictEqual(g.phase, 'build');
  assert.strictEqual(g.customers.length, 0);
  assert(g.stations.every(st => !st.item));
  assert.strictEqual(Object.values(g.upgrades).reduce((a, b) => a + b, 0), 1);
});

// ---- milestone 3: multiplayer support (no sockets: messages go through JSON) ---
const wire = obj => JSON.parse(JSON.stringify(obj));   // what PeerJS would do to a message

test('lobby phase waits for the host, then day 1 starts', () => {
  const g = Sim.createGame({ seed: 1, lobby: true });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  waitSeconds(g, p, CONFIG.prepTime + 10);
  assert.strictEqual(g.phase, 'lobby');
  assert.strictEqual(g.customers.length, 0);
  Sim.startGame(g);
  assert.strictEqual(g.phase, 'build');
  assert(Sim.drainEvents(g).some(e => e.type === 'phase' && e.phase === 'build'));
  Sim.finishBuild(g);
  assert.strictEqual(g.phase, 'prep');
});

test('snapshots keep a client game identical to the host', () => {
  const host = Sim.createGame({ seed: 7 });
  const a = Sim.addPlayer(host, 'a', 'Host', 0);
  Sim.addPlayer(host, 'b', 'Guest', 1);
  const client = Sim.createGame({ lobby: true });
  Sim.openDoors(host);
  for (let i = 0; i < 25 * 30; i++) {
    Sim.setInput(host, 'b', { mx: Math.sin(i / 20), my: Math.cos(i / 27), grabSeq: Math.floor(i / 40), use: i % 50 < 20 });
    Sim.setInput(host, 'a', { mx: Math.cos(i / 31), my: Math.sin(i / 17), grabSeq: Math.floor(i / 33), use: false });
    Sim.step(host, DT);
    if (i % 3 === 0) Sim.applySnapshot(client, wire(Sim.snapshot(host)));
  }
  Sim.applySnapshot(client, wire(Sim.snapshot(host)));
  assert(host.customers.length > 0, 'expected some customers by now');
  assert.strictEqual(JSON.stringify(Sim.snapshot(client)), JSON.stringify(Sim.snapshot(host)));
  assert(Math.abs(client.players.a.x - a.x) < 0.001);
});

test('client prediction plus replay matches the host under lag', () => {
  const host = Sim.createGame({ seed: 3 });
  Sim.addPlayer(host, 'b', 'Guest', 1);
  const client = Sim.createGame({ lobby: true });
  Sim.applySnapshot(client, wire(Sim.snapshot(host)));
  const LAG = 4;                                        // ticks each way
  const toHost = [], toClient = [], pending = [];
  let seq = 0, ack = 0;
  for (let i = 0; i < 300; i++) {
    // client: sample input, predict, send
    const input = { mx: i % 90 < 45 ? 1 : -1, my: i % 60 < 30 ? 0.6 : -0.6, s: ++seq };
    pending.push(input);
    Sim.predictMove(client, client.players.b, input, DT);
    toHost.push({ at: i + LAG, m: input });
    // host: consume one input per tick when it has arrived
    const next = toHost[0] && toHost[0].at <= i ? toHost.shift().m : null;
    if (next) { Sim.setInput(host, 'b', { mx: next.mx, my: next.my, grabSeq: 0, use: false }); ack = next.s; }
    Sim.step(host, DT);
    if (i % 2 === 0) toClient.push({ at: i + LAG, snap: wire(Sim.snapshot(host)), ack });
    // client: apply arrived snapshots and replay unacknowledged inputs
    while (toClient[0] && toClient[0].at <= i) {
      const predicted = { x: client.players.b.x, y: client.players.b.y };
      const { snap, ack: acked } = toClient.shift();
      Sim.applySnapshot(client, snap);
      for (const q of pending.filter(q => q.s > acked)) Sim.predictMove(client, client.players.b, q, DT);
      const err = Math.hypot(predicted.x - client.players.b.x, predicted.y - client.players.b.y);
      assert(err < 0.01, `prediction drifted by ${err.toFixed(3)} tiles at tick ${i}`);
    }
  }
});

// ---- milestone 5: progression ---------------------------------------------------
// Jump straight to an end-of-day summary with an offer on the table.
// (Earns enough XP to level up, since the upgrade vote only happens on level-up days.)
function toSummary(g, p, levelUp = true) {
  Sim.openDoors(g);
  g.day.nextArrival = Infinity;
  if (levelUp) g.day.stats.xp += Sim.xpNeeded(g.level) - g.xp;
  g.phaseTime = DT;
  tick(g, p, {}, 3);
  assert.strictEqual(g.phase, 'summary');
}
const gameWith = (seed, ids) => {
  const g = Sim.createGame({ seed });
  const ps = ids.map((id, i) => Sim.addPlayer(g, id, id, i));
  return { g, p: ps[0] };
};

test('votes: majority wins, ties go to the host, offers are 3 different upgrades', () => {
  const { g, p } = gameWith(5, ['host', 'b', 'c']);
  toSummary(g, p);
  const keys = g.offer.map(o => o.key);
  assert.strictEqual(new Set(keys).size, 3);
  Sim.vote(g, 'host', 0); Sim.vote(g, 'b', 1); Sim.vote(g, 'c', 1);
  Sim.nextDay(g, 'host');
  assert.strictEqual(g.upgrades[keys[1]], 1, 'majority should win');

  const t = gameWith(6, ['host', 'b']);
  toSummary(t.g, t.p);
  const k2 = t.g.offer.map(o => o.key);
  Sim.vote(t.g, 'host', 2); Sim.vote(t.g, 'b', 0);
  Sim.nextDay(t.g, 'host');
  assert.strictEqual(t.g.upgrades[k2[2]], 1, 'tie should go to the host');
  Sim.vote(t.g, 'b', 1);           // voting outside the summary is ignored
  assert.deepStrictEqual(Object.keys(t.g.votes), []);
});

test('upgrades change the game: faster chopping, new dish, cheaper shop, second wind', () => {
  const { g } = gameWith(1, ['a']);
  const chop = Sim.times(g).chop;
  Sim.applyUpgrade(g, 'quickKnives');
  assert(Math.abs(Sim.times(g).chop - chop * 0.7) < 1e-9);
  const hob = Sim.shopPrice(g, 'hob');
  Sim.applyUpgrade(g, 'bulkBuy');
  assert(Sim.shopPrice(g, 'hob') < hob);
  g.reputation = 1; Sim.applyUpgrade(g, 'secondWind'); assert.strictEqual(g.reputation, 2);
});

// Stand next to tile (x, y), facing it, ready to put a station down there.
function faceTile(g, p, x, y) {
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const sx = x + dx, sy = y + dy;
    if (Sim.isSolid(g, sx, sy)) continue;
    p.x = sx + 0.5; p.y = sy + 0.5; p.fx = -dx; p.fy = -dy;
    return;
  }
  throw new Error(`nowhere to stand next to ${x},${y}`);
}
const count = (g, type) => g.stations.filter(s => s.type === type).length;

test('shop: buy a hob and a table, place them, and they work in service', () => {
  const { g, p } = gameWith(31, ['a']);
  g.level = 10;                                   // everything in the shop unlocked
  assert.strictEqual(g.phase, 'build');
  g.money = 200;
  assert(Sim.buy(g, 'a', 'hob'));
  assert.strictEqual(p.held.k, 'station');
  assert(!Sim.buy(g, 'a', 'counter'), 'hands are full');
  faceTile(g, p, 4, 6); press(g, p);
  assert.strictEqual(count(g, 'hob'), 2);
  assert.strictEqual(g.money, 200 - Sim.shopPrice(g, 'hob'));
  assert(Sim.buy(g, 'a', 'table'));
  faceTile(g, p, 13, 10); press(g, p);
  assert.strictEqual(count(g, 'table'), 7);
  const table = g.stations.find(s => s.type === 'table' && s.x === 13 && s.y === 10);
  assert(table && table.seat, 'the new table gets a chair');
  // The new hob cooks.
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  const newHob = g.stations.find(s => s.type === 'hob' && s.x === 4 && s.y === 6);
  newHob.item = { k: 'patty' };
  waitSeconds(g, p, CONFIG.cookTime + 0.2);
  assert.strictEqual(newHob.item.k, 'cookedPatty');
  // And every table, old and new, can be reached.
  for (const t of g.stations.filter(s => s.type === 'table')) walkTo(g, p, t);
});

test('layout editor: move stations around, but never block paths or break the rules', () => {
  const { g, p } = gameWith(32, ['a']);
  g.level = 10;                                   // everything in the shop unlocked
  const sink = g.stations.find(s => s.type === 'sink');
  walkTo(g, p, sink); press(g, p);                 // pick the sink up
  assert.strictEqual(p.held.type, 'sink');
  assert.strictEqual(count(g, 'sink'), 0);
  faceTile(g, p, 7, 5); press(g, p);
  assert.strictEqual(count(g, 'sink'), 1);
  assert(g.stations.find(s => s.type === 'sink' && s.x === 7 && s.y === 5));
  // Not allowed: kitchen station in the dining room, anything in a doorway, a table in the kitchen.
  assert(!Sim.canPlace(g, 14, 9, 'hob').ok);
  assert(!Sim.canPlace(g, 10, 5, 'counter').ok);
  assert(!Sim.canPlace(g, 4, 6, 'table').ok);
  // Not allowed: walling off part of the kitchen. Fill a corridor and the last gap is refused.
  g.money = 1000;
  const blocked = [];
  for (let y = 1; y <= 10; y++) {
    if (Sim.isSolid(g, 9, y)) continue;
    Sim.buy(g, 'a', 'counter');
    faceTile(g, p, 8, y);
    p.x = 8.5; p.y = y + 0.5; p.fx = 1; p.fy = 0;
    if (Sim.isSolid(g, 8, y)) { p.held = null; continue; }
    press(g, p);
    if (p.held) { blocked.push(y); p.held = null; }
  }
  assert(blocked.length > 0, 'some placement should have been refused to keep paths open');
  assert(g.stations.every(st => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !Sim.isSolid(g, st.x + dx, st.y + dy))));
});

test('selling: half price back, full refund if just bought, and never the last hob', () => {
  const { g, p } = gameWith(33, ['a']);
  g.level = 10;                                   // everything in the shop unlocked
  const bin = g.stations.find(s => s.type === 'bin');
  walkTo(g, p, bin);
  const money = g.money;
  Sim.buy(g, 'a', 'counter'); press(g, p);         // straight into the bin: full refund
  assert.strictEqual(p.held, null);
  assert.strictEqual(g.money, money);
  const hob = g.stations.find(s => s.type === 'hob');
  walkTo(g, p, hob); press(g, p);
  walkTo(g, p, g.stations.find(s => s.type === 'bin')); press(g, p);
  assert.strictEqual(p.held.type, 'hob', 'the only hob cannot be sold');
  // Selling an existing station (not just bought) gives half its price back.
  Sim.finishBuild(g);                               // the hob goes home
  g.phase = 'build';
  const counter = g.stations.find(s => s.type === 'counter' && s.y === 4);
  walkTo(g, p, counter); press(g, p);
  const before = g.money;
  walkTo(g, p, g.stations.find(s => s.type === 'bin')); press(g, p);
  assert.strictEqual(g.money - before, Math.floor(SHOP.counter.price * CONFIG.sellRefund));
  assert.strictEqual(count(g, 'hob'), 1);
});

test('finishing setup puts carried stations back, and clients rebuild the same layout', () => {
  const { g, p } = gameWith(34, ['a']);
  const hob = g.stations.find(s => s.type === 'hob');
  const [hx, hy] = [hob.x, hob.y];
  walkTo(g, p, hob); press(g, p);
  assert.strictEqual(count(g, 'hob'), 0);
  Sim.finishBuild(g);
  assert.strictEqual(g.phase, 'prep');
  assert.strictEqual(p.held, null);
  assert(g.stations.find(s => s.type === 'hob' && s.x === hx && s.y === hy), 'hob goes back home');

  const m = gameWith(35, ['a']);
  m.g.money = 100; m.g.level = 10;
  Sim.buy(m.g, 'a', 'table'); faceTile(m.g, m.p, 16, 5); press(m.g, m.p);
  const client = Sim.createGame({ lobby: true });
  Sim.applySnapshot(client, wire(Sim.snapshot(m.g)));
  assert.strictEqual(client.tiles.join(''), m.g.tiles.join(''));
  assert(client.stations.every((s, i) => s.type === m.g.stations[i].type && s.x === m.g.stations[i].x));
});

test('a new run after game over restores the original kitchen and money', () => {
  const { g, p } = gameWith(3, ['a']);
  g.level = 10;                                   // everything in the shop unlocked
  g.money = 100;
  Sim.buy(g, 'a', 'table'); faceTile(g, p, 16, 5); press(g, p);
  Sim.applyUpgrade(g, 'trainers');
  Sim.endRun(g);
  Sim.newRun(g);
  assert.strictEqual(g.venue, CONFIG.startVenue, 'a new restaurant opens in the start venue');
  assert.strictEqual(g.layout.join(), VENUES[CONFIG.startVenue].rows.join());
  assert.strictEqual(g.mods.speed, 1);
  assert.strictEqual(g.money, CONFIG.startMoney);
  assert.deepStrictEqual(Object.keys(g.upgrades), []);
});

// Force one event to happen right now.
function runEvent(g, p, key) {
  if (g.phase !== 'service') Sim.openDoors(g);
  g.day.nextArrival = Infinity;
  g.day.schedule = [{ key, at: 0, state: 'pending', until: 0, target: -1 }];
  tick(g, p, {});
  return g.day.schedule[0];
}

test('events: cold hob stops cooking, late delivery empties a crate', () => {
  const { g, p } = gameWith(4, ['a']);
  const hob = g.stations.find(s => s.type === 'hob');
  hob.item = { k: 'patty' };
  const e = runEvent(g, p, 'coldHob');
  assert.strictEqual(e.target, hob.id);
  const frozenAt = hob.item.cook || 0;          // it may have cooked during the tick the event began
  waitSeconds(g, p, 10);
  assert.strictEqual(hob.item.cook || 0, frozenAt, 'a cold hob should not cook');
  waitSeconds(g, p, EVENTS.coldHob.duration);
  assert(hob.item.cook > 0, 'the hob should come back');

  const late = runEvent(g, p, 'late');
  const crate = g.stations[late.target];
  assert(['patty', 'bun'].includes(crate.crateItem), 'should empty a crate the menu needs');
  walkTo(g, p, crate); press(g, p);
  assert.strictEqual(p.held, null);
  waitSeconds(g, p, EVENTS.late.duration + 0.1);
  press(g, p);
  assert.strictEqual(p.held.k, crate.crateItem);
});

test('events: VIP pays more but is less patient; rush doubles arrivals', () => {
  const { g, p } = gameWith(5, ['a']);
  runEvent(g, p, 'vip');
  const vip = g.customers.find(c => c.vip);
  assert(vip, 'a VIP should arrive');
  untilState(g, p, vip, 'waiting');
  assert(Math.abs(vip.maxPatience - CONFIG.patience * CONFIG.vipPatience) < 1e-9);
  p.held = burgerPlate();
  const before = g.money;
  walkTo(g, p, tableOf(g, vip)); press(g, p);
  assert(g.money - before >= RECIPES.burger.price * CONFIG.vipPriceMultiplier);

  const r = gameWith(6, ['a']);
  runEvent(r.g, r.p, 'rush');
  r.g.day.nextArrival = 10;
  waitSeconds(r.g, r.p, 5.1);
  assert(r.g.day.nextArrival <= 0.1 || r.g.customers.length > 0, 'rush should halve the wait');
});

test('events: fussy customers change order; the inspector punishes dirty plates', () => {
  const { g, p } = gameWith(7, ['a']);
  g.menu = ['burger', 'salad'];
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  const c = Sim.spawnCustomer(g);
  untilState(g, p, c, 'waiting');
  runEvent(g, p, 'fussy');
  assert(c.fussy);
  const first = c.order;
  waitSeconds(g, p, c.maxPatience * (1 - CONFIG.fussyChangeAt) + 1);
  assert(c.changed); assert.notStrictEqual(c.order, first);

  const i = gameWith(8, ['a']);
  i.g.stations.find(s => s.type === 'counter').item = { k: 'dirtyPlate' };
  runEvent(i.g, i.p, 'inspector');
  waitSeconds(i.g, i.p, EVENTS.inspector.duration + 0.1);
  assert.strictEqual(i.g.reputation, CONFIG.startReputation - CONFIG.inspectorPenalty);

  const ok = gameWith(9, ['a']);
  runEvent(ok.g, ok.p, 'inspector');
  waitSeconds(ok.g, ok.p, EVENTS.inspector.duration + 0.1);
  assert.strictEqual(ok.g.money, CONFIG.startMoney + CONFIG.inspectorBonus);
});

test('runs differ: different seeds give different events and upgrade offers', () => {
  const plan = seed => {
    const { g, p } = gameWith(seed, ['a']);
    const seen = [];
    for (let day = 1; day <= 6; day++) {
      seen.push(g.day.schedule.map(e => e.key).join('+'));
      g.reputation = 5;
      toSummary(g, p);
      seen.push(g.offer.map(o => o.key).join(','));
      Sim.nextDay(g, 'a');
    }
    return { seen: seen.join('|'), events: seen.filter((s, i) => i % 2 === 0 && s).length, g };
  };
  const a = plan(11), b = plan(12), c = plan(13);
  assert(a.seen !== b.seen && b.seen !== c.seen && a.seen !== c.seen);
  assert(a.events + b.events + c.events >= 6, 'expected a decent number of events over 3×6 days');
  assert.strictEqual(a.g.dayNum, 7);
  // Later days are harder: shorter gaps and less patience.
  assert(Object.values(a.g.upgrades).reduce((x, y) => x + y, 0) === 6);
});

// ---- milestone 6: options and tuning --------------------------------------------
test('the chosen day length is used for service and reaches clients', () => {
  const g = Sim.createGame({ seed: 1, dayLength: 120 });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  Sim.openDoors(g);
  assert.strictEqual(g.phaseTime, 120);
  g.day.nextArrival = Infinity;
  waitSeconds(g, p, 120.1);
  assert.notStrictEqual(g.phase, 'service');
  const client = Sim.createGame({ lobby: true });
  Sim.applySnapshot(client, wire(Sim.snapshot(g)));
  assert.strictEqual(client.dayLength, 120);
});

test('more chefs bring more customers', () => {
  const arrivals = chefs => {
    const g = Sim.createGame({ seed: 4, dayLength: 240 });
    for (let i = 0; i < chefs; i++) Sim.addPlayer(g, 'p' + i, 'P' + i, i);
    g.reputation = 1e9;                        // nobody loses, we just count
    Sim.openDoors(g);
    for (let i = 0; i < 240 / DT; i++) Sim.step(g, DT);
    return g.day.stats.arrivals;
  };
  const one = arrivals(1), four = arrivals(4);
  assert(four > one * 1.6, `4 chefs: ${four} arrivals vs 1 chef: ${one}`);
});

test('a resumed host snapshot restores the run exactly (host refresh)', () => {
  const { g, p } = gameWith(21, ['host', 'b']);
  g.money = 100; g.level = 10;
  Sim.buy(g, 'host', 'table'); faceTile(g, p, 16, 5); press(g, p);
  Sim.openDoors(g);
  waitSeconds(g, p, 40);
  const saved = wire(Sim.snapshot(g));
  const back = Sim.createGame({ lobby: true });
  Sim.applySnapshot(back, saved);
  assert.strictEqual(JSON.stringify(Sim.snapshot(back)), JSON.stringify(Sim.snapshot(g)));
  // Both carry on identically, random numbers included.
  for (let i = 0; i < 300; i++) { Sim.step(g, DT); Sim.step(back, DT); }
  assert.strictEqual(JSON.stringify(Sim.snapshot(back)), JSON.stringify(Sim.snapshot(g)));
});

// ---- progression milestone 1: saves and checkpoints --------------------------------
// Play through a whole day quickly: doors open, nobody comes, the vote picks something.
function finishDay(g, p) {
  Sim.openDoors(g);
  g.day.nextArrival = Infinity;
  g.phaseTime = DT;
  tick(g, p, {}, 3);
  assert.strictEqual(g.phase, 'summary');
  Sim.nextDay(g, p.id);
}

test('a save round-trips: the loaded restaurant matches what was saved', () => {
  const { g, p } = gameWith(41, ['a']);
  g.money = 333; g.totalEarned = 500; g.reputation = 4.5;
  Sim.applyUpgrade(g, 'trainers'); g.level = 3; g.xp = 40;
  Sim.buy(g, 'a', 'hob'); faceTile(g, p, 4, 6); press(g, p);
  const data = wire(Sim.serialiseState(g));
  assert.strictEqual(data.saveVersion, CONFIG.saveVersion);
  const back = Sim.createGame({ lobby: true });
  Sim.loadState(back, data);
  assert.strictEqual(back.money, g.money); assert.strictEqual(back.reputation, 4.5);
  assert.strictEqual(back.layout.join(), g.layout.join());
  assert.strictEqual(count(back, 'hob'), 2);
  assert.strictEqual(back.mods.speed, g.mods.speed);
  assert.strictEqual(back.level, 3); assert.strictEqual(back.xp, 40);
  assert.strictEqual(JSON.stringify(back.menu), JSON.stringify(g.menu));
  // A loaded restaurant starts at its saved day when the host presses start.
  back.dayNum = 5; Sim.addPlayer(back, 'a', 'A', 0); Sim.startGame(back);
  assert.strictEqual(back.dayNum, 5); assert.strictEqual(back.phase, 'build');
});

test('checkpoints are taken at the start of days 1, 4, 7…', () => {
  const { g, p } = gameWith(42, ['a']);
  assert.strictEqual(g.checkpoint.dayNum, 1);
  for (let d = 1; d <= 6; d++) {
    g.reputation = 5;
    finishDay(g, p);
    const expected = 1 + Math.floor((g.dayNum - 1) / CONFIG.checkpointEvery) * CONFIG.checkpointEvery;
    assert.strictEqual(g.checkpoint.dayNum, expected, `on day ${g.dayNum}`);
  }
  assert.strictEqual(g.dayNum, 7);
});

test('closing down resets everything to the last checkpoint', () => {
  const { g, p } = gameWith(43, ['a']);
  for (let d = 1; d <= 3; d++) { g.reputation = 5; finishDay(g, p); }   // checkpoint at day 4
  assert.strictEqual(g.dayNum, 4);
  const cp = wire(g.checkpoint);
  g.level = 10;
  // Days 4 and 5: earn money and buy things; then fail on day 6.
  g.money += 400;
  Sim.buy(g, 'a', 'table'); faceTile(g, p, 16, 5); press(g, p);
  finishDay(g, p); finishDay(g, p);
  assert.strictEqual(g.dayNum, 6);
  Sim.openDoors(g);
  g.day.nextArrival = Infinity;
  g.reputation = 0.5;
  const c = Sim.spawnCustomer(g);
  untilState(g, p, c, 'waiting');
  c.patience = 0.01;
  tick(g, p, {}, 3);
  assert.strictEqual(g.phase, 'gameover');
  assert.strictEqual(g.summary.backTo, 4);
  Sim.restoreCheckpoint(g);
  assert.strictEqual(g.dayNum, 4); assert.strictEqual(g.phase, 'build');
  assert.strictEqual(g.money, cp.money);
  assert.strictEqual(g.reputation, cp.reputation);
  assert.strictEqual(g.layout.join(), cp.layout.join(), 'the table bought after the checkpoint is gone');
  assert.strictEqual(g.bestDay, 6, 'best day is a stat and survives the reset');
  assert.strictEqual(g.resets, 1);
});

test('old and broken saves are handled; newer saves are refused', () => {
  const g = Sim.createGame({ lobby: true });
  // A version-0 save missing most fields still loads with sensible defaults.
  Sim.loadState(g, { dayNum: 3, money: 50 });
  assert.strictEqual(g.dayNum, 3); assert.strictEqual(g.money, 50);
  assert.strictEqual(g.reputation, CONFIG.startReputation);
  assert.strictEqual(g.layout.join(), g.map.rows.join());
  // Rubbish in the layout, menu or upgrades is ignored rather than crashing the game.
  Sim.loadState(g, { saveVersion: 1, dayNum: 2, layout: ['nope'], menu: ['burger', 'mystery'], upgrades: { fake: 3 } });
  assert.strictEqual(g.layout.join(), g.map.rows.join());
  assert.strictEqual(JSON.stringify(g.menu), '["burger"]');
  assert.strictEqual(Object.keys(g.upgrades).length, 0);
  assert.throws(() => Sim.loadState(g, { saveVersion: CONFIG.saveVersion + 1 }), /newer version/);
  assert.throws(() => Sim.loadState(g, null), /empty or broken/);
});

// ---- progression milestone 2: toppings, menu board, XP and levels -----------------
test('orders have no toppings at level 1, and lettuce/tomato toppings from level 2', () => {
  const { g } = gameWith(51, ['a']);
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  for (let i = 0; i < 20; i++) assert.strictEqual(Sim.spawnCustomer(g).order.tops.length, 0);
  g.level = 2;
  const tops = new Set();
  for (let i = 0; i < 40; i++) Sim.spawnCustomer(g).order.tops.forEach(t => tops.add(t));
  assert(tops.has('choppedLettuce') && tops.has('choppedTomato'));
});

test('a plate must match the order exactly, toppings included, and toppings cost extra', () => {
  const { g, p } = gameWith(52, ['a']);
  g.level = 2;
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  const c = Sim.spawnCustomer(g);
  c.order = { dish: 'burger', tops: ['choppedTomato'] };
  untilState(g, p, c, 'waiting');
  const table = tableOf(g, c);
  p.held = burgerPlate();                                    // no tomato: wrong
  walkTo(g, p, table); press(g, p);
  assert.strictEqual(c.state, 'waiting');
  p.held = { k: 'plate', parts: ['bun', 'cookedPatty', 'choppedTomato', 'choppedLettuce'] };   // extra lettuce: wrong
  press(g, p);
  assert.strictEqual(c.state, 'waiting');
  p.held = { k: 'plate', parts: ['cookedPatty', 'choppedTomato', 'bun'] };                     // any order of layers
  const before = g.money;
  press(g, p);
  assert.strictEqual(c.state, 'eating');
  assert(g.money - before >= RECIPES.burger.price + CONFIG.toppingPrice);
  assert.strictEqual(Sim.orderPrice({ dish: 'burger', tops: ['choppedTomato', 'choppedLettuce'] }), RECIPES.burger.price + 2 * CONFIG.toppingPrice);
  assert.strictEqual(Sim.dishOf(p.held || { k: 'plate', parts: ['bun', 'cookedPatty', 'choppedLettuce'] }), 'burger');
});

test('serving earns XP; a good day levels the restaurant up and only then offers a vote', () => {
  const { g, p } = gameWith(53, ['a']);
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  for (let i = 0; i < 3; i++) {
    const c = Sim.spawnCustomer(g);
    untilState(g, p, c, 'waiting');
    p.held = burgerPlate(); walkTo(g, p, tableOf(g, c)); press(g, p);
  }
  assert(g.day.stats.xp >= 3 * CONFIG.xpPerServe * 0.5);
  waitSeconds(g, p, CONFIG.eatTime + 8);                    // let them eat and leave
  // Not enough for a level: no vote.
  toSummary(g, p, false);
  assert.strictEqual(g.level, 1);
  assert.strictEqual(g.offer.length, 0);
  assert(g.summary.xpGained >= g.day.stats.xp + CONFIG.xpNoWalkouts, 'no-walkouts bonus included');
  assert.strictEqual(g.summary.next.level, 2);
  assert(g.summary.next.keys.includes('toppings'));
  Sim.nextDay(g, 'a');
  assert.strictEqual(Object.keys(g.upgrades).length, 0, 'no upgrade without a level-up');
  // Enough XP: level 2, toppings unlocked, and a vote.
  toSummary(g, p, true);
  assert.strictEqual(g.level, 2);
  assert.strictEqual(g.offer.length, CONFIG.upgradeChoices);
  assert(g.summary.unlocked.includes('toppings') && g.summary.unlocked.includes('shop:table'));
  assert.strictEqual(g.summary.xp, g.xp, 'summary shows progress within the new level');
  assert(g.summary.xp < g.summary.xpNeeded);
  assert(Sim.toppingsUnlocked(g));
});

test('menu board: only unlocked dishes, never empty, guests suggest, more dishes bigger tips', () => {
  const { g, p } = gameWith(54, ['host', 'b']);
  assert.strictEqual(g.phase, 'build');
  assert(!Sim.setMenuDish(g, 'salad', true), 'salad is locked at level 1');
  assert(!Sim.setMenuDish(g, 'burger', false), 'the menu cannot be empty');
  g.level = Sim.unlockLevel('dish:salad');
  assert(Sim.proposeMenuDish(g, 'b', 'salad'));
  assert.strictEqual(g.menuProposals.salad, 'b');
  assert(Sim.setMenuDish(g, 'salad', true));
  assert(g.menu.includes('salad'));
  assert.strictEqual(g.menuProposals.salad, undefined, 'accepting clears the suggestion');
  // Same customer, same speed: the bigger menu tips more.
  const tipWith = menu => {
    const t = gameWith(55, ['a']);
    t.g.level = 10; t.g.menu = menu;
    Sim.openDoors(t.g); t.g.day.nextArrival = Infinity;
    const c = Sim.spawnCustomer(t.g);
    c.order = { dish: 'burger', tops: [] };
    untilState(t.g, t.p, c, 'waiting');
    t.p.held = burgerPlate(); walkTo(t.g, t.p, tableOf(t.g, c));
    c.patience = c.maxPatience;
    press(t.g, t.p);
    return t.g.day.stats.tips;
  };
  assert(tipWith(['burger', 'salad']) > tipWith(['burger']));
});

test('version 1 saves upgrade to version 2: level 1, salad burger removed', () => {
  const g = Sim.createGame({ lobby: true });
  Sim.loadState(g, { saveVersion: 1, dayNum: 6, money: 90, menu: ['burger', 'cheeseless_salad_burger'], upgrades: { newDish: 1, trainers: 1 } });
  assert.strictEqual(g.level, 1); assert.strictEqual(g.xp, 0);
  assert.strictEqual(JSON.stringify(g.menu), '["burger"]');
  assert.strictEqual(JSON.stringify(g.upgrades), '{"trainers":1}');
});

// ---- progression milestone 3: level-gated shop -------------------------------------
test('shop items are locked until their level; owned stations can still be moved', () => {
  const { g, p } = gameWith(61, ['a']);
  g.money = 500;
  assert(!Sim.buy(g, 'a', 'hob'), 'hob is locked at level 1');
  assert(!Sim.buy(g, 'a', 'table'), 'table is locked at level 1');
  assert.strictEqual(g.money, 500);
  assert(Sim.shopUnlocked(g, 'sink') && Sim.shopUnlocked(g, 'rack'));
  assert.strictEqual(Sim.unlockLevel('shop:hob'), 3);
  g.level = 2;
  assert(!Sim.buy(g, 'a', 'hob'));
  assert(Sim.buy(g, 'a', 'table'), 'tables unlock at level 2');
  p.held = null;
  g.level = 3;
  assert(Sim.buy(g, 'a', 'hob'), 'hobs unlock at level 3');
  p.held = null;
  // Level doesn't matter for moving what you already own.
  g.level = 1;
  const hob = g.stations.find(s => s.type === 'hob');
  walkTo(g, p, hob); press(g, p);
  assert.strictEqual(p.held.type, 'hob');
  // Every unlock in CONFIG refers to something that exists.
  for (const keys of Object.values(CONFIG.unlocks)) {
    for (const k of keys) {
      const [kind, name] = k.split(':');
      assert(k === 'toppings' || (kind === 'shop' && SHOP[name]) || (kind === 'dish' && RECIPES[name]) || (kind === 'staff' && CONFIG.staff[name]) || (kind === 'venue' && VENUES[name]), `unknown unlock ${k}`);
    }
  }
});

// ---- progression milestone 4: serving hatch and conveyor belts ----------------------
// Buy a station and put it on (x, y), standing on (sx, sy).
function buyPlace(g, p, key, x, y, sx, sy) {
  assert(Sim.buy(g, p.id, key), `could not buy ${key}`);
  p.x = sx + 0.5; p.y = sy + 0.5;
  p.fx = Math.sign(x - sx); p.fy = Math.sign(y - sy);
  press(g, p);
  assert.strictEqual(p.held, null, `could not place ${key} at ${x},${y}`);
}

test('hatch: only in the dividing wall with floor both sides; picking it up restores the wall', () => {
  const { g, p } = gameWith(71, ['a']);
  g.level = 10; g.money = 500;
  assert(!Sim.canPlace(g, 10, 1, 'hatch').ok, 'a counter is on the kitchen side there');
  assert(!Sim.canPlace(g, 4, 6, 'hatch').ok, 'not in the middle of the kitchen');
  assert(!Sim.canPlace(g, 0, 3, 'hatch').ok, 'not in the outer wall');
  assert(Sim.canPlace(g, 10, 3, 'hatch').ok);
  buyPlace(g, p, 'hatch', 10, 3, 9, 3);
  assert.strictEqual(g.tiles[3 * g.w + 10], 'P');
  walkTo(g, p, g.stations.find(s => s.type === 'hatch')); press(g, p);
  assert.strictEqual(p.held.type, 'hatch');
  assert.strictEqual(g.tiles[3 * g.w + 10], '#', 'the wall comes back');
});

test('hatch: a matching plate is sent to the customer; anyone on the dining side can take it', () => {
  const { g, p } = gameWith(72, ['a']);
  g.level = 10; g.money = 500;
  buyPlace(g, p, 'hatch', 10, 3, 9, 3);
  const hatch = g.stations.find(s => s.type === 'hatch');
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  const c = Sim.spawnCustomer(g);
  c.order = { dish: 'burger', tops: [] };
  untilState(g, p, c, 'waiting');
  hatch.item = { k: 'plate', parts: ['bun'] };             // not a match: stays put
  waitSeconds(g, p, CONFIG.hatchDeliverTime + 0.5);
  assert.strictEqual(c.state, 'waiting');
  // From the dining side, pick it up
  p.x = 11.5; p.y = 3.5; p.fx = -1; p.fy = 0;
  press(g, p);
  assert.strictEqual(p.held.k, 'plate');
  hatch.item = burgerPlate();
  const before = g.money;
  waitSeconds(g, p, CONFIG.hatchDeliverTime + 0.2);
  assert.strictEqual(c.state, 'eating', 'auto-delivered');
  assert.strictEqual(hatch.item, null);
  assert(g.money > before);
  assert.strictEqual(tableOf(g, c).item.k, 'plate');
});

test('belts: point the way you face, carry items along, and serve tables or feed the sink', () => {
  const { g, p } = gameWith(73, ['a']);
  g.level = 10; g.money = 500;
  // Two belts on row 6 of the kitchen: (4,6) → (5,6)
  buyPlace(g, p, 'belt', 4, 6, 4, 7);                   // facing up: this one points up
  assert.strictEqual(g.tiles[6 * g.w + 4], '^');
  walkTo(g, p, g.stations.find(s => s.type === 'belt' && s.x === 4)); press(g, p);   // lift it again
  p.x = 3.5; p.y = 6.5; p.fx = 1; p.fy = 0; press(g, p);  // facing right now
  assert.strictEqual(g.tiles[6 * g.w + 4], '>');
  buyPlace(g, p, 'belt', 5, 6, 5, 7);
  assert.strictEqual(g.tiles[6 * g.w + 5], '^');
  Sim.finishBuild(g);
  // An item on the first belt moves onto the second, which points up at a counter (5,5)…
  const b1 = g.stations.find(s => s.type === 'belt' && s.x === 4), b2 = () => g.stations.find(s => s.type === 'belt' && s.x === 5);
  const counter = g.stations.find(s => s.type === 'counter' && s.x === 5 && s.y === 5);
  counter.item = { k: 'tomato' };                         // …which is full, so the bun will wait
  b1.item = { k: 'bun' }; b1.prog = 0.5;
  waitSeconds(g, p, 1.5);
  assert.strictEqual(b1.item, null);
  assert.strictEqual(b2().item.k, 'bun');
  waitSeconds(g, p, 2);
  assert.strictEqual(b2().item.k, 'bun', 'the counter is full: it waits at the end');
  assert.strictEqual(b2().prog, 1);
  counter.item = null;                                   // clear the counter and the bun goes on
  tick(g, p, {}, 2);
  assert.strictEqual(counter.item.k, 'bun');
});

test('belts deliver to tables (only matching plates) and dirty plates to the sink', () => {
  const { g, p } = gameWith(74, ['a']);
  g.level = 10; g.money = 500;
  // Table (12,3) has its chair above. A belt at (12,4) pointing up feeds it.
  buyPlace(g, p, 'belt', 12, 4, 12, 5);
  assert.strictEqual(g.tiles[4 * g.w + 12], '^');
  // Sink at (9,7): belt at (8,7) pointing right feeds it.
  buyPlace(g, p, 'belt', 8, 7, 7, 7);
  assert.strictEqual(g.tiles[7 * g.w + 8], '>');
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  const table = g.stations.find(s => s.type === 'table' && s.x === 12 && s.y === 3);
  const c = Sim.spawnCustomer(g);
  c.order = { dish: 'burger', tops: [] };
  // Make sure our customer sits at that table.
  for (const t of g.stations.filter(s => s.type === 'table' && s !== table)) t.item = { k: 'dirtyPlate' };
  untilState(g, p, c, 'waiting');
  assert.strictEqual(c.table, table.id);
  const tableBelt = g.stations.find(s => s.type === 'belt' && s.x === 12);
  tableBelt.item = { k: 'plate', parts: ['bun'] }; tableBelt.prog = 0.5;     // wrong: waits
  waitSeconds(g, p, 1.5);
  assert.strictEqual(c.state, 'waiting');
  tableBelt.item = burgerPlate(); tableBelt.prog = 0.5;
  waitSeconds(g, p, 1.5);
  assert.strictEqual(c.state, 'eating', 'the belt served the customer');
  const sinkBelt = g.stations.find(s => s.type === 'belt' && s.x === 8);
  const sink = g.stations.find(s => s.type === 'sink');
  sinkBelt.item = { k: 'dirtyPlate' }; sinkBelt.prog = 0.5;
  waitSeconds(g, p, 1.5);
  assert.strictEqual(sink.dirty, 1);
});

test('hatch and belts are level-gated, survive saves and sync to clients', () => {
  const { g, p } = gameWith(75, ['a']);
  g.money = 500;
  g.level = 3; assert(!Sim.buy(g, 'a', 'hatch')); assert(!Sim.buy(g, 'a', 'belt'));
  g.level = 4; assert(Sim.buy(g, 'a', 'hatch')); p.held = null; assert(!Sim.buy(g, 'a', 'belt'));
  g.level = 6;
  buyPlace(g, p, 'belt', 4, 6, 4, 7);
  buyPlace(g, p, 'hatch', 10, 3, 9, 3);
  const back = Sim.createGame({ lobby: true });
  Sim.loadState(back, wire(Sim.serialiseState(g)));
  assert.strictEqual(back.layout.join(), g.layout.join());
  const client = Sim.createGame({ lobby: true });
  g.stations.find(s => s.type === 'belt').item = { k: 'bun' };
  Sim.applySnapshot(client, wire(Sim.snapshot(g)));
  assert.strictEqual(client.stations.find(s => s.type === 'belt').item.k, 'bun');
  assert.strictEqual(client.stations.find(s => s.type === 'hatch').x, 10);
});

// ---- progression milestone 5: staff and wages ---------------------------------------
// Runs a service with no new customers, for watching staff work.
function quietService(g) {
  Sim.finishBuild(g);
  Sim.openDoors(g);
  g.day.nextArrival = Infinity;
}
const staffOf = (g, role) => g.players['staff-' + role];

test('hiring: level-gated, one per role, grades swap, firing removes them; not counted as chefs', () => {
  const { g } = gameWith(81, ['a']);
  assert(!Sim.hireStaff(g, 'cleaner', 0), 'cleaners unlock at level 5');
  g.level = 5;
  assert(Sim.hireStaff(g, 'cleaner', 0));
  assert(staffOf(g, 'cleaner') && staffOf(g, 'cleaner').staff);
  assert(!Sim.hireStaff(g, 'runner', 0), 'runners unlock at level 7');
  assert(Sim.hireStaff(g, 'cleaner', 1), 'swap to a Pro');
  assert.strictEqual(g.staff.length, 1);
  assert.strictEqual(staffOf(g, 'cleaner').tier, 1);
  assert.strictEqual(Sim.wageBill(g), CONFIG.staff.cleaner.tiers[1].wage);
  // Staff don't count as chefs for customer numbers.
  const solo = gameWith(81, ['a']).g;
  solo.level = g.level;                                  // same level, so the same random rolls
  Sim.openDoors(g); Sim.openDoors(solo);
  g.day.nextArrival = solo.day.nextArrival = 0;
  tick(g, g.players.a, {}); Sim.step(solo, DT);
  assert(Math.abs(g.day.nextArrival - solo.day.nextArrival) < 1e-9, 'same arrival gap as a solo chef');
  g.phase = 'build';
  assert(Sim.fireStaff(g, 'cleaner'));
  assert.strictEqual(staffOf(g, 'cleaner'), undefined);
  assert.strictEqual(Sim.wageBill(g), 0);
});

test('wages are paid at the end of the day; if the till is short, you lose half a star', () => {
  const { g, p } = gameWith(82, ['a']);
  g.level = 9;
  Sim.hireStaff(g, 'cleaner', 1); Sim.hireStaff(g, 'runner', 1);
  const bill = Sim.wageBill(g);
  g.money = bill + 7;
  toSummary(g, p, false);
  assert.strictEqual(g.money, 7);
  assert.strictEqual(g.summary.wages, bill);
  assert.strictEqual(g.summary.unpaid, 0);
  Sim.nextDay(g, 'a');
  const rep = g.reputation;
  g.money = 10;
  toSummary(g, p, false);
  assert.strictEqual(g.money, 0);
  assert.strictEqual(g.summary.unpaid, bill - 10);
  assert.strictEqual(g.reputation, rep - CONFIG.unpaidWagesPenalty);
});

test('cleaner: fetches dirty plates, washes them and racks the clean ones', () => {
  const { g } = gameWith(83, ['a']);
  g.level = 5;
  Sim.hireStaff(g, 'cleaner', 1);
  const t1 = g.stations.find(s => s.type === 'table' && s.x === 12 && s.y === 3);
  const t2 = g.stations.find(s => s.type === 'table' && s.x === 15 && s.y === 8);
  quietService(g);
  t1.item = { k: 'dirtyPlate' }; t2.item = { k: 'dirtyPlate' };
  const rack = g.stations.find(s => s.type === 'rack');
  rack.plates = 0;
  const sink = g.stations.find(s => s.type === 'sink');
  const p = g.players.a;
  p.x = 3.5; p.y = 9.5;                                  // keep the player out of the way
  for (let i = 0; i < 60 / DT && (t1.item || t2.item || sink.dirty || sink.clean || staffOf(g, 'cleaner').held); i++) tick(g, p, {});
  assert.strictEqual(t1.item, null); assert.strictEqual(t2.item, null);
  assert.strictEqual(sink.dirty, 0);
  assert(rack.plates >= 2, `rack has ${rack.plates}`);
});

test('runner: carries a finished plate from a counter to the matching customer', () => {
  const { g } = gameWith(84, ['a']);
  g.level = 7;
  Sim.hireStaff(g, 'runner', 1);
  quietService(g);
  const c = Sim.spawnCustomer(g);
  c.order = { dish: 'burger', tops: [] };
  const p = g.players.a;
  p.x = 3.5; p.y = 9.5;
  untilState(g, p, c, 'waiting');
  const counter = g.stations.find(s => s.type === 'counter' && s.x === 9 && s.y === 8);
  counter.item = burgerPlate();
  for (let i = 0; i < 30 / DT && c.state === 'waiting'; i++) tick(g, p, {});
  assert.strictEqual(c.state, 'eating', 'the runner served it');
  assert.strictEqual(counter.item, null);
});

test('prep chef: keeps chopped lettuce and tomato ready on the counters', () => {
  const { g } = gameWith(85, ['a']);
  g.level = 9;
  Sim.hireStaff(g, 'prep', 1);
  quietService(g);
  const p = g.players.a;
  p.x = 7.5; p.y = 9.5;
  const out = k => g.stations.filter(s => s.type === 'counter' && s.item && s.item.k === k).length;
  for (let i = 0; i < 90 / DT && (out('choppedLettuce') < CONFIG.prepBuffer || out('choppedTomato') < CONFIG.prepBuffer); i++) tick(g, p, {});
  assert.strictEqual(out('choppedLettuce'), CONFIG.prepBuffer);
  assert.strictEqual(out('choppedTomato'), CONFIG.prepBuffer);
  waitSeconds(g, p, 10);
  assert.strictEqual(out('choppedLettuce'), CONFIG.prepBuffer, 'stops at the buffer');
});

test('staff survive saves (v2 saves get none) and sync to clients', () => {
  const { g } = gameWith(86, ['a']);
  g.level = 9;
  Sim.hireStaff(g, 'prep', 0); Sim.hireStaff(g, 'cleaner', 1);
  const back = Sim.createGame({ lobby: true });
  Sim.addPlayer(back, 'a', 'A', 0);
  Sim.loadState(back, wire(Sim.serialiseState(g)));
  Sim.startGame(back);
  assert.strictEqual(JSON.stringify(back.staff), JSON.stringify(g.staff));
  assert(staffOf(back, 'prep') && staffOf(back, 'cleaner'));
  const old = Sim.createGame({ lobby: true });
  Sim.loadState(old, { saveVersion: 2, dayNum: 3, staff: [{ role: 'cleaner', tier: 0 }] });
  assert.strictEqual(old.staff.length, 0, 'version 2 saves predate staff');
  const client = Sim.createGame({ lobby: true });
  Sim.applySnapshot(client, wire(Sim.snapshot(g)));
  assert(client.players['staff-cleaner'].staff);
  assert.strictEqual(client.players['staff-cleaner'].role, 'cleaner');
});

// ---- progression milestone 6: new dishes and stations -------------------------------
// A level-11 kitchen with every new station bought and placed (rows 3 and 6).
function bigKitchen(seed) {
  const { g, p } = gameWith(seed, ['a']);
  g.level = 11; g.money = 2000;
  buyPlace(g, p, 'fryer', 3, 6, 3, 7);
  buyPlace(g, p, 'potatoCrate', 4, 6, 4, 7);
  buyPlace(g, p, 'sausageCrate', 5, 6, 5, 7);
  buyPlace(g, p, 'drinks', 7, 6, 7, 7);
  buyPlace(g, p, 'oven', 8, 6, 8, 7);
  buyPlace(g, p, 'doughCrate', 3, 3, 3, 4);
  buyPlace(g, p, 'fridge', 8, 3, 8, 4);
  return { g, p, at: type => g.stations.find(s => s.type === type) };
}
// Serve `plate` to a fresh customer who orders `order`.
function serveOrder(g, p, order, plate) {
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  const c = Sim.spawnCustomer(g);
  c.order = order;
  untilState(g, p, c, 'waiting');
  p.held = plate;
  walkTo(g, p, tableOf(g, c)); press(g, p);
  return c;
}

test('chips: chop a potato, fry it, plate it, serve it', () => {
  const { g, p, at } = bigKitchen(91);
  Sim.finishBuild(g);
  walkTo(g, p, g.stations.find(s => s.type === 'crate' && s.crateItem === 'potato')); press(g, p);
  assert.strictEqual(p.held.k, 'potato');
  const board = at('board');
  walkTo(g, p, board); press(g, p); hold(g, p, CONFIG.chopTime + 0.1);
  assert.strictEqual(board.item.k, 'cutPotato');
  press(g, p);
  const fryer = at('fryer');
  walkTo(g, p, fryer); press(g, p);
  waitSeconds(g, p, CONFIG.fryTime + 0.2);
  assert.strictEqual(fryer.item.k, 'chips');
  p.held = { k: 'plate', parts: [] }; press(g, p);       // plate grabs the chips straight from the fryer
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.held.parts)), ['chips']);
  const c = serveOrder(g, p, { dish: 'chips', tops: [] }, p.held);
  assert.strictEqual(c.state, 'eating');
});

test('chips burn if left in the fryer', () => {
  const { g, p, at } = bigKitchen(92);
  Sim.finishBuild(g);
  const fryer = at('fryer');
  fryer.item = { k: 'cutPotato' };
  waitSeconds(g, p, CONFIG.fryTime + CONFIG.fryBurnTime + 0.3);
  assert.strictEqual(fryer.item.k, 'burntChips');
});

test('hot dog: cook a sausage on the hob, put it in a bun on a plate', () => {
  const { g, p, at } = bigKitchen(93);
  Sim.finishBuild(g);
  const hob = at('hob');
  hob.item = { k: 'sausage' };
  waitSeconds(g, p, CONFIG.cookTime + 0.2);
  assert.strictEqual(hob.item.k, 'cookedSausage');
  walkTo(g, p, hob);
  p.held = { k: 'plate', parts: ['bun'] }; press(g, p);
  assert.strictEqual(Sim.dishOf(p.held), 'hotdog');
  assert(!Sim.canAddToPlate(p.held, { k: 'cookedPatty' }), 'no sausage-burger hybrids');
  const c = serveOrder(g, p, { dish: 'hotdog', tops: [] }, p.held);
  assert.strictEqual(c.state, 'eating');
});

test('drinks: the machine fills a cup by itself; served without a plate, leaves no dirty plate', () => {
  const { g, p, at } = bigKitchen(94);
  Sim.finishBuild(g);
  const machine = at('drinks');
  waitSeconds(g, p, CONFIG.drinkTime + 0.1);
  assert.strictEqual(machine.item.k, 'drink');
  walkTo(g, p, machine); press(g, p);
  assert.strictEqual(p.held.k, 'drink');
  const c = serveOrder(g, p, { dish: 'drink', tops: [] }, p.held);
  assert.strictEqual(c.state, 'eating');
  const table = tableOf(g, c);
  waitSeconds(g, p, CONFIG.eatTime + 0.2);
  assert.strictEqual(table.item, null, 'no dirty plate after a drink');
});

test('pizza: dough + chopped tomato make a raw pizza, the oven bakes it', () => {
  const { g, p, at } = bigKitchen(95);
  Sim.finishBuild(g);
  const counter = g.stations.find(s => s.type === 'counter' && s.x === 5 && s.y === 4);
  counter.item = { k: 'dough' };
  walkTo(g, p, counter);
  p.held = { k: 'choppedTomato' }; press(g, p);
  assert.strictEqual(counter.item.k, 'rawPizza');
  assert.strictEqual(p.held, null);
  press(g, p);
  const oven = at('oven');
  walkTo(g, p, oven); press(g, p);
  waitSeconds(g, p, CONFIG.bakeTime + 0.2);
  assert.strictEqual(oven.item.k, 'pizza');
  p.held = { k: 'plate', parts: [] }; press(g, p);
  const c = serveOrder(g, p, { dish: 'pizza', tops: [] }, p.held);
  assert.strictEqual(c.state, 'eating');
});

test('dessert: ice cream from the freezer onto a plate', () => {
  const { g, p } = bigKitchen(96);
  Sim.finishBuild(g);
  const freezer = g.stations.find(s => s.type === 'crate' && s.crateItem === 'iceCream');
  walkTo(g, p, freezer);
  p.held = { k: 'plate', parts: [] }; press(g, p);
  assert.strictEqual(Sim.dishOf(p.held), 'dessert');
  const c = serveOrder(g, p, { dish: 'dessert', tops: [] }, p.held);
  assert.strictEqual(c.state, 'eating');
});

test('menu board: a dish needs its stations; selling one takes it off the menu', () => {
  const { g, p } = gameWith(97, ['a']);
  g.level = 11; g.money = 2000;
  assert(!Sim.setMenuDish(g, 'chips', true), 'no fryer or potato crate yet');
  buyPlace(g, p, 'fryer', 3, 6, 3, 7);
  assert(!Sim.setMenuDish(g, 'chips', true), 'still no potato crate');
  buyPlace(g, p, 'potatoCrate', 4, 6, 4, 7);
  assert(Sim.setMenuDish(g, 'chips', true));
  // New crates can be moved (unlike the four you start with) and sold.
  const crate = g.stations.find(s => s.type === 'crate' && s.crateItem === 'potato');
  walkTo(g, p, crate); press(g, p);
  assert.strictEqual(p.held.type, 'potatoCrate');
  walkTo(g, p, g.stations.find(s => s.type === 'bin')); press(g, p);
  assert.strictEqual(p.held, null, 'sold');
  const original = g.stations.find(s => s.type === 'crate' && s.crateItem === 'patty');
  walkTo(g, p, original); press(g, p);
  assert.strictEqual(p.held, null, 'the original crates stay put');
  Sim.finishBuild(g);
  assert(!g.menu.includes('chips'), 'chips come off the menu without a potato crate');
  assert(Sim.drainEvents(g).some(e => e.type === 'menuDropped'));
});

test('every recipe and cooker refers to items that exist', () => {
  for (const [k, r] of Object.entries(RECIPES)) {
    for (const n of r.needs.concat(r.toppings)) assert(ITEMS[n], `${k} needs unknown item ${n}`);
    for (const x of r.requires || []) assert(SHOP[x], `${k} requires unknown shop item ${x}`);
  }
});

// ---- progression milestone 7: customer types and venues -----------------------------
test('every venue builds, every station and table is reachable, spawns are free', () => {
  for (const key in VENUES) {
    const g = Sim.createGame({ seed: 1, venue: key });
    const p = Sim.addPlayer(g, 'a', 'A', 0);
    assert.strictEqual(g.venue, key);
    for (const sp of g.spawns) assert(!Sim.isSolid(g, sp[0], sp[1]), `${key}: spawn ${sp} is blocked`);
    const tables = g.stations.filter(s => s.type === 'table');
    assert(tables.length >= 3, `${key} has ${tables.length} tables`);
    for (const s of g.stations) walkTo(g, p, s);
    for (const t of tables) assert(t.seat, `${key}: table at ${t.x},${t.y} has no seat`);
  }
});

test('food truck: customers stand outside and are served through the windows', () => {
  const g = Sim.createGame({ seed: 2, venue: 'foodTruck' });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  const c = Sim.spawnCustomer(g, { type: 'normal' });
  c.order = { dish: 'burger', tops: [] };
  untilState(g, p, c, 'waiting');
  const win = tableOf(g, c);
  assert.strictEqual(win.look, 'window');
  p.held = burgerPlate();
  walkTo(g, p, win); press(g, p);
  assert.strictEqual(c.state, 'eating');
  waitSeconds(g, p, CONFIG.eatTime + 0.2);
  assert.strictEqual(win.item.k, 'dirtyPlate', 'they leave the plate on the window ledge');
  assert(!Sim.canPlace(g, 5, 5, 'table').ok, 'no room for tables in a truck');
});

test('moving venue: level-gated, costs money, brings chosen extras and sells the rest', () => {
  const g = Sim.createGame({ seed: 3, venue: 'greasySpoon' });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  g.money = 1000;
  assert(!Sim.moveVenue(g, 'diner', {}), 'the diner unlocks at level 6');
  g.level = 6;
  buyPlace(g, p, 'hob', 3, 4, 3, 5);
  buyPlace(g, p, 'counter', 6, 4, 6, 5);
  buyPlace(g, p, 'counter', 5, 6, 5, 7);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(Sim.venueExtras(g))), { hob: 1, counter: 2 });
  const before = g.money;
  assert(Sim.moveVenue(g, 'diner', { hob: 1, counter: 1 }));
  assert.strictEqual(g.venue, 'diner');
  assert.strictEqual(g.w, 20);
  const extras = Sim.venueExtras(g);
  assert.strictEqual(extras.hob, 1, 'brought the hob');
  assert.strictEqual(extras.counter, 1, 'brought one counter');
  assert.strictEqual(g.money, before - VENUES.diner.price + Math.floor(SHOP.counter.price * CONFIG.venueSellRate));
  for (const id in g.players) assert(!Sim.isSolid(g, Math.floor(g.players[id].x), Math.floor(g.players[id].y)));
  // It all survives a save and reaches clients.
  const back = Sim.createGame({ lobby: true, venue: 'greasySpoon' });
  Sim.loadState(back, wire(Sim.serialiseState(g)));
  assert.strictEqual(back.venue, 'diner'); assert.strictEqual(back.layout.join(), g.layout.join());
  const client = Sim.createGame({ lobby: true, venue: 'greasySpoon' });
  Sim.applySnapshot(client, wire(Sim.snapshot(g)));
  assert.strictEqual(client.venue, 'diner'); assert.strictEqual(client.w, 20);
  assert.strictEqual(client.tiles.join(''), g.tiles.join(''));
});

test('customer types join by level; lads are impatient, families order several plates', () => {
  const { g, p } = gameWith(101, ['a']);
  assert.strictEqual(Sim.typeWeight(g, 'lads'), 0);
  assert.strictEqual(Sim.typeWeight(g, 'critic'), 0);
  g.level = 6;
  assert(Sim.typeWeight(g, 'lads') > 0 && Sim.typeWeight(g, 'family') > 0 && Sim.typeWeight(g, 'critic') > 0);
  assert.strictEqual(Sim.typeWeight(g, 'regular'), 0, 'no regulars yet');
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  const lad = Sim.spawnCustomer(g, { type: 'lads' }), norm = Sim.spawnCustomer(g, { type: 'normal' });
  untilState(g, p, lad, 'waiting'); untilState(g, p, norm, 'waiting');
  assert(lad.maxPatience < norm.maxPatience * 0.7);
  const fam = Sim.spawnCustomer(g, { type: 'family' });
  fam.order = { dish: 'burger', tops: [] };
  untilState(g, p, fam, 'waiting');
  const n = fam.left;
  assert(n >= 2);
  const money = g.money;
  for (let i = 0; i < n; i++) {
    assert.strictEqual(fam.state, 'waiting');
    p.held = burgerPlate(); walkTo(g, p, tableOf(g, fam)); press(g, p);
  }
  assert.strictEqual(fam.state, 'eating');
  assert(g.money - money >= n * RECIPES.burger.price, 'every plate paid');
});

test('critics move the stars; regulars come back with bigger tips and leave for good if mistreated', () => {
  const { g, p } = gameWith(102, ['a']);
  g.level = 6;
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  const crit = Sim.spawnCustomer(g, { type: 'critic' });
  crit.order = { dish: 'burger', tops: [] };
  untilState(g, p, crit, 'waiting');
  const rep = g.reputation;
  p.held = burgerPlate(); walkTo(g, p, tableOf(g, crit)); press(g, p);
  assert.strictEqual(g.reputation, rep + CONFIG.criticStars, 'quick service pleases the critic');
  // Regulars: force one to appear and compare tips with a normal customer at the same speed.
  g.regulars = [{ id: 1, look: 7, visits: 1 }];
  assert(Sim.typeWeight(g, 'regular') > 0);
  const tipFor = type => {
    const c = Sim.spawnCustomer(g, { type });
    c.order = { dish: 'burger', tops: [] };
    untilState(g, p, c, 'waiting');
    p.held = burgerPlate(); walkTo(g, p, tableOf(g, c));
    c.patience = c.maxPatience;
    const tips = g.day.stats.tips;
    press(g, p);
    return { c, tip: g.day.stats.tips - tips };
  };
  const reg = tipFor('regular'), nor = tipFor('normal');
  assert.strictEqual(reg.c.regularId, 1); assert.strictEqual(reg.c.look, 7);
  assert(reg.tip > nor.tip, `regular tipped ${reg.tip}, normal ${nor.tip}`);
  assert.strictEqual(g.regulars[0].visits, 2);
  // A regular who storms out is gone. (Wait for the last one to finish eating and leave first.)
  waitSeconds(g, p, CONFIG.eatTime + 10);
  const angry = Sim.spawnCustomer(g, { type: 'regular' });
  untilState(g, p, angry, 'waiting');
  angry.patience = 0.01; tick(g, p, {}, 2);
  assert.strictEqual(g.regulars.length, 0);
});

test('version 3 saves stay in the diner; new restaurants open in the greasy spoon', () => {
  const g = Sim.createGame({ lobby: true, venue: CONFIG.startVenue });
  Sim.loadState(g, { saveVersion: 3, dayNum: 4, layout: VENUES.diner.rows });
  assert.strictEqual(g.venue, 'diner');
  assert.strictEqual(g.layout.join(), VENUES.diner.rows.join());
  const fresh = Sim.createGame({ lobby: true, venue: CONFIG.startVenue });
  assert.strictEqual(fresh.venue, 'greasySpoon');
});

const asyncTests = [];
const testAsync = (name, fn) => asyncTests.push([name, fn]);

testAsync('save codes encode and decode, and reject damaged codes', async () => {
  const { g } = gameWith(44, ['a']);
  g.money = 1234;
  const bundle = { saveVersion: CONFIG.saveVersion, autosave: Sim.serialiseState(g), checkpoint: g.checkpoint };
  const code = await SaveCode.encode(bundle);
  assert(/^HOBMOB\d+[zj]\./.test(code), code.slice(0, 20));
  assert(code.length < 3000, `code is ${code.length} characters`);
  const pasted = '  ' + code.slice(0, 40) + '\n' + code.slice(40) + '  ';   // copied with line breaks
  const back = await SaveCode.decode(pasted);
  assert.strictEqual(back.autosave.money, 1234);
  await assert.rejects(SaveCode.decode('hello'), /look like/);
  await assert.rejects(SaveCode.decode(code.slice(0, code.length - 30)), /incomplete or damaged/);
});

(async () => {
  for (const [name, fn] of asyncTests) {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
