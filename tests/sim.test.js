// Runs the game simulation from index.html in Node, without a browser.
// Usage: node tests/sim.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = html.match(/<script id="sim">([\s\S]*?)<\/script>/)[1];
const { Sim, CONFIG, RECIPES, EVENTS, SHOP, SaveCode, ITEMS, VENUES, FLOORS, ACHIEVEMENTS, GOALS } = vm.runInNewContext(src + '\n;({ Sim, CONFIG, RECIPES, EVENTS, SHOP, SaveCode, ITEMS, VENUES, FLOORS, ACHIEVEMENTS, GOALS })', {
  CompressionStream, DecompressionStream, Response, Blob, TextEncoder, TextDecoder, btoa, atob,
});

// The real starting layouts have only a few tables. Most tests were written for the original,
// table-rich layouts, so they run on those (the old tables put back); withRealLayouts() switches back.
const REAL_ROWS = {}, LEGACY_TABLES = { greasySpoon: [[12, 3]], diner: [[15, 3], [12, 8], [18, 8]], bigRestaurant: [[17, 3], [17, 10]] };
for (const key in VENUES) {
  REAL_ROWS[key] = VENUES[key].rows;
  const rows = VENUES[key].rows.map(r => r.split(''));
  for (const [x, y] of LEGACY_TABLES[key] || []) rows[y][x] = 'T';
  VENUES[key].rows = rows.map(r => r.join(''));
}
const LEGACY_ROWS = {};
for (const key in VENUES) LEGACY_ROWS[key] = VENUES[key].rows;
function withRealLayouts(fn) {
  for (const key in VENUES) VENUES[key].rows = REAL_ROWS[key];
  try { fn(); } finally { for (const key in VENUES) VENUES[key].rows = LEGACY_ROWS[key]; }
}

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
  g.goalIndex = 999;                 // shared goals pay out money; keep them out of tests that don't test them
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
  assert(Math.abs(vip.maxPatience - CONFIG.patience * (g.map.patienceMultiplier || 1) * CONFIG.vipPatience) < 1e-9);
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
  assert(four > one * 1.4, `4 chefs: ${four} arrivals vs 1 chef: ${one}`);
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
      assert(k === 'toppings' || k === 'beltLane2' || (kind === 'shop' && SHOP[name]) || (kind === 'dish' && RECIPES[name]) || (kind === 'staff' && CONFIG.staff[name]) || (kind === 'venue' && VENUES[name]) || (kind === 'floor' && FLOORS[name]), `unknown unlock ${k}`);
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
  assert.strictEqual(c.plate.k, 'plate', 'the plate is in front of the customer');
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
  // Table (12,3) has chairs above and below. A belt at (13,3) pointing left feeds it.
  buyPlace(g, p, 'belt', 13, 3, 14, 3);
  assert.strictEqual(g.tiles[3 * g.w + 13], '<');
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
  const tableBelt = g.stations.find(s => s.type === 'belt' && s.x === 13);
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
test('every venue builds, every station and table is reachable, spawns are free', () => withRealLayouts(() => {
  for (const key in VENUES) {
    const g = Sim.createGame({ seed: 1, venue: key });
    const p = Sim.addPlayer(g, 'a', 'A', 0);
    assert.strictEqual(g.venue, key);
    for (const sp of g.spawns) assert(!Sim.isSolid(g, sp[0], sp[1]), `${key}: spawn ${sp} is blocked`);
    const tables = g.stations.filter(s => s.type === 'table');
    assert(tables.length >= 2, `${key} has ${tables.length} tables`);
    for (const s of g.stations) walkTo(g, p, s);
    for (const t of tables) assert(t.seat, `${key}: table at ${t.x},${t.y} has no seat`);
  }
}));

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

test('venues unlock in order (level + cash), switching keeps each venue exactly as it was', () => {
  const g = Sim.createGame({ seed: 3, venue: 'greasySpoon' });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  g.money = 2000;
  g.level = 10;
  assert(!Sim.unlockVenue(g, 'diner'), 'the Food Truck must be unlocked first');
  assert.strictEqual(Sim.venueBlocker(g, 'diner'), 'Unlock the Food Truck first');
  g.level = 3;
  assert.strictEqual(Sim.venueBlocker(g, 'foodTruck'), 'Needs level 4');
  g.level = 10;
  // Put something in the Greasy Spoon so we can check it's still there later.
  buyPlace(g, p, 'hob', 3, 4, 3, 5);
  const spoonLayout = g.layout.join();
  const money = g.money;
  assert(Sim.unlockVenue(g, 'foodTruck'));
  assert.strictEqual(g.money, money - VENUES.foodTruck.unlockCost);
  assert(Sim.unlockVenue(g, 'diner'));
  assert.strictEqual(g.venue, 'greasySpoon', 'unlocking does not move you');
  assert(Sim.switchVenue(g, 'diner'));
  assert.strictEqual(g.venue, 'diner'); assert.strictEqual(g.w, 20);
  assert.strictEqual(g.layout.join(), VENUES.diner.rows.join());
  for (const id in g.players) assert(!Sim.isSolid(g, Math.floor(g.players[id].x), Math.floor(g.players[id].y)));
  // Change the Diner, go back to the Greasy Spoon: it's untouched, and nothing was sold.
  buyPlace(g, p, 'counter', 4, 6, 4, 7);
  const dinerLayout = g.layout.join();
  const before = g.money;
  assert(Sim.switchVenue(g, 'greasySpoon'));
  assert.strictEqual(g.layout.join(), spoonLayout);
  assert.strictEqual(g.money, before, 'switching costs and sells nothing');
  assert(Sim.switchVenue(g, 'diner'));
  assert.strictEqual(g.layout.join(), dinerLayout);
  // Only between days.
  Sim.finishBuild(g);
  assert(!Sim.switchVenue(g, 'greasySpoon'));
  // It all survives a save and reaches clients.
  g.phase = 'build';
  const back = Sim.createGame({ lobby: true, venue: 'greasySpoon' });
  Sim.loadState(back, wire(Sim.serialiseState(g)));
  assert.strictEqual(back.venue, 'diner'); assert.strictEqual(back.layout.join(), dinerLayout);
  assert.strictEqual(back.venues.greasySpoon.layout.join(), spoonLayout);
  assert(back.venues.foodTruck.unlocked);
  const client = Sim.createGame({ lobby: true, venue: 'greasySpoon' });
  Sim.applySnapshot(client, wire(Sim.snapshot(g)));
  assert.strictEqual(client.venue, 'diner'); assert.strictEqual(client.tiles.join(''), g.tiles.join(''));
  assert(Sim.venueSummary(client).foodTruck.unlocked);
});

test('each venue has its own stars and stats; closing down restores every venue', () => {
  const g = Sim.createGame({ seed: 4, venue: 'greasySpoon' });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  g.goalIndex = 999;
  g.money = 2000; g.level = 10;
  Sim.unlockVenue(g, 'foodTruck');
  g.reputation = 4.5;                                    // the Greasy Spoon's stars
  Sim.switchVenue(g, 'foodTruck');
  assert.strictEqual(g.reputation, CONFIG.startReputation, 'the Food Truck has its own rating');
  g.reputation = 2;
  Sim.switchVenue(g, 'greasySpoon');
  assert.strictEqual(g.reputation, 4.5);
  // A day in the Greasy Spoon counts for the Greasy Spoon.
  toSummary(g, p, false);
  assert.strictEqual(Sim.venueSummary(g).greasySpoon.days, 1);
  assert.strictEqual(Sim.venueSummary(g).foodTruck.days, 0);
  Sim.nextDay(g, 'a');
  // Checkpoint is at day 1; change both venues, then close down: everything goes back.
  const cp = wire(g.checkpoint);
  Sim.switchVenue(g, 'foodTruck');
  buyPlace(g, p, 'counter', 7, 3, 7, 4);
  Sim.switchVenue(g, 'greasySpoon');
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  g.reputation = 0.5;
  const c = Sim.spawnCustomer(g, { type: 'normal' });
  untilState(g, p, c, 'waiting'); c.patience = 0.01; tick(g, p, {}, 2);
  assert.strictEqual(g.phase, 'gameover');
  Sim.restoreCheckpoint(g);
  assert.strictEqual(g.venues.foodTruck.layout.join(), cp.venues.foodTruck.layout.join(), 'the Food Truck goes back too');
  assert.strictEqual(g.layout.join(), cp.venues.greasySpoon.layout.join());
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

test('old saves restart the ladder in the Greasy Spoon; their venue is kept, locked, with nothing lost', () => {
  // A version-5 save in the Diner with an extra hob placed.
  const dinerLayout = VENUES.diner.rows.slice();
  dinerLayout[6] = '#C...H.............D';
  const g = Sim.createGame({ lobby: true, venue: CONFIG.startVenue });
  Sim.loadState(g, { saveVersion: 5, dayNum: 12, venue: 'diner', layout: dinerLayout, money: 777, level: 8, reputation: 4,
    staff: [{ role: 'cleaner', tier: 1 }], achievements: { firstDay: 2 }, name: 'Old Place' });
  assert.strictEqual(g.venue, 'greasySpoon');
  assert.strictEqual(g.layout.join(), VENUES.greasySpoon.rows.join());
  assert.strictEqual(g.venues.diner.layout.join(), dinerLayout.join(), 'the Diner layout is kept');
  assert(!g.venues.diner.unlocked && !g.venues.foodTruck.unlocked, 'climb back up the ladder');
  assert.strictEqual(g.money, 777); assert.strictEqual(g.level, 8); assert.strictEqual(g.dayNum, 12);
  assert.strictEqual(g.reputation, 4); assert.strictEqual(g.staff.length, 1);
  assert(g.achievements.firstDay); assert.strictEqual(g.name, 'Old Place');
  // Level 8 and £777: unlock the Food Truck then the Diner, and the old Diner is back exactly.
  Sim.addPlayer(g, 'a', 'A', 0);
  Sim.startGame(g);
  assert(Sim.unlockVenue(g, 'foodTruck') && Sim.unlockVenue(g, 'diner'));
  assert(Sim.switchVenue(g, 'diner'));
  assert.strictEqual(g.layout.join(), dinerLayout.join());
  // New restaurants start in the Greasy Spoon too.
  const fresh = Sim.createGame({ lobby: true, venue: CONFIG.startVenue });
  assert.strictEqual(fresh.venue, 'greasySpoon');
  assert.strictEqual(CONFIG.startVenue, 'greasySpoon');
  // The venue unlock levels in CONFIG.unlocks (for the "next unlock" preview) match VENUES.
  for (const key in VENUES) if (key !== CONFIG.startVenue) assert.strictEqual(Sim.unlockLevel('venue:' + key), VENUES[key].unlockLevel, key);
});

// ---- progression milestone 8: contracts, achievements, records, decor, goals ----------
// Serve n burgers to fresh customers (plain, quick service).
function serveBurgers(g, p, n) {
  for (let i = 0; i < n; i++) {
    const c = Sim.spawnCustomer(g, { type: 'normal' });
    c.order = { dish: 'burger', tops: [] };
    untilState(g, p, c, 'waiting');
    p.held = burgerPlate(); walkTo(g, p, tableOf(g, c)); c.patience = c.maxPatience; press(g, p);
    waitSeconds(g, p, CONFIG.eatTime + 6);              // let them leave so tables free up
  }
}

test('contracts: one a day, progress during service, cash and XP when done', () => {
  const { g, p } = gameWith(111, ['a']);
  Sim.openDoors(g);
  assert(g.day.contract, 'a contract on day 1');
  g.day.contract = { key: 'serveDish', dish: 'burger', target: 2, progress: 0, done: false, failed: false, cash: 50, xp: 70 };
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  serveBurgers(g, p, 2);
  assert(g.day.contract.done);
  assert(Sim.drainEvents(g).some(e => e.type === 'contract'));
  const money = g.money;
  toSummary(g, p, false);
  assert.strictEqual(g.money, money + 50);
  assert(g.summary.xpBonuses.some(([k, x]) => k === 'Contract' && x === 70));
  assert.strictEqual(g.life.contracts, 1);
  Sim.nextDay(g, 'a');
  assert(g.day.contract && g.day.contract !== null, 'a new contract for day 2');
  // "No walkouts" fails on the first walkout.
  g.day.contract = { key: 'noWalkouts', target: 1, progress: 0, done: false, failed: false, cash: 50, xp: 70 };
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  const c = Sim.spawnCustomer(g, { type: 'normal' });
  untilState(g, p, c, 'waiting'); c.patience = 0.01; tick(g, p, {}, 2);
  assert(g.day.contract.failed);
  waitSeconds(g, p, 4);                                  // let them storm out of the door
  const m2 = g.money;
  toSummary(g, p, false);
  assert.strictEqual(g.money, m2, 'no reward');
  assert(Sim.contractText({ key: 'serveDish', dish: 'burger', target: 6 }).includes('6 × Burger'));
});

test('achievements unlock once, announce themselves, and survive closing down', () => {
  const { g, p } = gameWith(112, ['a']);
  toSummary(g, p, false);
  assert(g.achievements.firstDay, 'finished the first day');
  assert(Sim.drainEvents(g).some(e => e.type === 'achievement' && e.id === 'firstDay'));
  g.reputation = 5; Sim.checkAchievements(g);
  assert(g.achievements.fiveStars);
  Sim.nextDay(g, 'a');
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  g.reputation = 0.5;
  const c = Sim.spawnCustomer(g, { type: 'normal' });
  untilState(g, p, c, 'waiting'); c.patience = 0.01; tick(g, p, {}, 2);
  assert.strictEqual(g.phase, 'gameover');
  Sim.restoreCheckpoint(g);
  assert(g.achievements.firstDay && g.achievements.fiveStars, 'achievements are history');
  assert.strictEqual(g.runDays, 0, 'the run starts again');
  assert(ACHIEVEMENTS.length >= 15);
});

test('records: best day takings and served, best run', () => {
  const { g, p } = gameWith(113, ['a']);
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  serveBurgers(g, p, 2);
  toSummary(g, p, false);
  assert.strictEqual(g.records.bestDayServed, 2);
  assert(g.records.bestDayTakings >= 2 * RECIPES.burger.price);
  assert(g.summary.newRecords.includes('served'));
  Sim.nextDay(g, 'a');
  toSummary(g, p, false);                              // a quiet day: no new records
  assert.strictEqual(g.records.bestDayServed, 2);
  assert.strictEqual(g.summary.newRecords.length, 0);
  assert.strictEqual(g.records.bestRun, 2);
});

test('decor: plants and wall art add patience, wall art leaves the wall behind; floors; the restaurant name', () => {
  const { g, p } = gameWith(115, ['a']);
  g.level = 11; g.money = 1000;
  assert.strictEqual(Sim.decorBonus(g), 0);
  buyPlace(g, p, 'plant', 13, 5, 13, 6);
  assert(Sim.canPlace(g, 10, 2, 'art').ok, 'the dividing wall is fine');
  buyPlace(g, p, 'art', 10, 2, 9, 2);
  assert.strictEqual(g.tiles[2 * g.w + 10], 'A');
  assert(Math.abs(Sim.decorBonus(g) - (CONFIG.decorPlant + CONFIG.decorArt)) < 1e-9);
  // Customers really are more patient.
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  const c = Sim.spawnCustomer(g, { type: 'normal' });
  untilState(g, p, c, 'waiting');
  const t = gameWith(115, ['a']); t.g.level = 11;
  Sim.openDoors(t.g); t.g.day.nextArrival = Infinity;
  const d = Sim.spawnCustomer(t.g, { type: 'normal' });
  untilState(t.g, t.p, d, 'waiting');
  assert(c.maxPatience > d.maxPatience * 1.04, `${c.maxPatience} vs ${d.maxPatience}`);
  // Lifting wall art puts the wall back.
  g.phase = 'build';
  walkTo(g, p, g.stations.find(s => s.look === 'art')); press(g, p);
  assert.strictEqual(p.held.type, 'art');
  assert.strictEqual(g.tiles[2 * g.w + 10], '#');
  p.held = null;
  // Floors: buy, then switch freely; each owned floor adds patience.
  assert(!Sim.buyFloor(Object.assign(gameWith(1, ['a']).g, { level: 1 }), 'checker'), 'locked at level 1');
  const money = g.money;
  assert(Sim.buyFloor(g, 'checker'));
  assert.strictEqual(g.money, money - FLOORS.checker.price);
  assert(Sim.buyFloor(g, 'wood')); assert.strictEqual(g.decor.floor, 'wood');
  assert(Sim.buyFloor(g, 'checker')); assert.strictEqual(g.money, money - FLOORS.checker.price, 'switching back is free');
  // Name
  Sim.setName(g, '  <Sam\'s Café>!!  ');
  assert.strictEqual(g.name, "Sam's Café!!");
  // Decor and name are saved and synced.
  const back = Sim.createGame({ lobby: true });
  Sim.loadState(back, wire(Sim.serialiseState(g)));
  assert.strictEqual(back.name, g.name); assert.strictEqual(back.decor.floor, 'checker');
  const client = Sim.createGame({ lobby: true });
  Sim.applySnapshot(client, wire(Sim.snapshot(g)));
  assert.strictEqual(client.decor.floor, 'checker');
});

test('shared goals: progress, a reward, then the next goal; old saves start at goal 1', () => {
  const g = Sim.createGame({ seed: 116 });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  assert.strictEqual(Sim.goalProgress(g).text, GOALS[0].text);
  g.level = 3;
  const money = g.money;
  toSummary(g, p, false);
  assert.strictEqual(g.goalIndex, 1, 'reached level 3');
  assert.strictEqual(g.money, money + CONFIG.goalReward);
  assert(Sim.drainEvents(g).some(e => e.type === 'goal'));
  const old = Sim.createGame({ lobby: true });
  Sim.loadState(old, { saveVersion: 4, dayNum: 9, venue: 'diner', level: 7 });
  assert.strictEqual(old.goalIndex, 0);
  assert.strictEqual(Object.keys(old.achievements).length, 0);
});

test('hats are part of the player and reach clients', () => {
  const g = Sim.createGame({ seed: 117 });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  assert.strictEqual(p.hat, 'none');
  p.hat = 'crown';
  const client = Sim.createGame({ lobby: true });
  Sim.applySnapshot(client, wire(Sim.snapshot(g)));
  assert.strictEqual(client.players.a.hat, 'crown');
});

// ---- extras: the second conveyor lane and progression events ---------------------------
test('second conveyor lane: from level 10 a belt carries two items side by side', () => {
  const { g, p } = gameWith(121, ['a']);
  g.level = 9; g.money = 500;
  // Belt at (13,3) pointing left into the table at (12,3).
  buyPlace(g, p, 'belt', 13, 3, 14, 3);
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  const belt = g.stations.find(s => s.type === 'belt');
  p.x = 14.5; p.y = 3.5; p.fx = -1; p.fy = 0;
  p.held = { k: 'bun' }; press(g, p);
  p.held = { k: 'tomato' }; press(g, p);
  assert.strictEqual(p.held.k, 'tomato', 'one lane below level 10: the belt is full');
  p.held = null;
  g.level = 10;
  assert.strictEqual(Sim.beltLanes(g), 2);
  p.held = { k: 'tomato' }; press(g, p);
  assert.strictEqual(p.held, null);
  assert.strictEqual(belt.item2.k, 'tomato', 'second lane');
  // Both lanes deliver: a matching plate in lane two serves the customer while lane one waits.
  belt.item = { k: 'bun' }; belt.prog = 1;
  const table = g.stations.find(s => s.type === 'table' && s.x === 12 && s.y === 3);
  for (const t of g.stations.filter(s => s.type === 'table' && s !== table)) t.item = { k: 'dirtyPlate' };
  const c = Sim.spawnCustomer(g, { type: 'normal' });
  c.order = { dish: 'burger', tops: [] };
  untilState(g, p, c, 'waiting');
  belt.item2 = burgerPlate(); belt.prog2 = 0.5;
  waitSeconds(g, p, 1.5);
  assert.strictEqual(c.state, 'eating');
  assert.strictEqual(belt.item.k, 'bun', 'lane one still waiting');
  // Both lanes sync to clients.
  belt.item2 = { k: 'lettuce' };
  const client = Sim.createGame({ lobby: true });
  Sim.applySnapshot(client, wire(Sim.snapshot(g)));
  const cb = client.stations.find(s => s.type === 'belt');
  assert.strictEqual(cb.item.k, 'bun'); assert.strictEqual(cb.item2.k, 'lettuce');
});

test('progression events only join the pool from their level', () => {
  const { g } = gameWith(122, ['a']);
  g.money = 500;
  const extra = ['happyHour', 'strike', 'coach', 'powerCut', 'critics', 'vipNight', 'heatwave'];
  g.level = 2;
  assert.deepStrictEqual(extra.filter(k => Sim.eventEligible(g, k)), [], 'none at level 2');
  g.level = 6;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(extra.filter(k => Sim.eventEligible(g, k)))), ['happyHour', 'strike', 'coach', 'powerCut']);
  g.level = 9;
  assert.strictEqual(extra.filter(k => Sim.eventEligible(g, k)).length, extra.length);
});

test('events: happy hour doubles tips, heatwave drains patience faster', () => {
  const tipWith = happy => {
    const { g, p } = gameWith(123, ['a']);
    g.level = 9;
    if (happy) runEvent(g, p, 'happyHour'); else { Sim.openDoors(g); g.day.nextArrival = Infinity; }
    const c = Sim.spawnCustomer(g, { type: 'normal' });
    c.order = { dish: 'burger', tops: [] };
    untilState(g, p, c, 'waiting');
    p.held = burgerPlate(); walkTo(g, p, tableOf(g, c)); c.patience = c.maxPatience; press(g, p);
    return g.day.stats.tips;
  };
  const normal = tipWith(false), happy = tipWith(true);
  assert(happy >= normal * 2 - 1 && happy > normal, `happy hour ${happy} vs ${normal}`);
  const { g, p } = gameWith(124, ['a']);
  g.level = 9;
  runEvent(g, p, 'heatwave');
  const c = Sim.spawnCustomer(g, { type: 'normal' });
  untilState(g, p, c, 'waiting');
  const before = c.patience;
  waitSeconds(g, p, 10);
  assert(before - c.patience > 14, `lost ${before - c.patience} in 10s`);
});

test('events: supplier strike empties two crates, power cut stops cookers and belts', () => {
  const { g, p } = gameWith(125, ['a']);
  g.level = 9; g.menu = ['burger'];
  const e = runEvent(g, p, 'strike');
  const empty = g.stations.filter(s => s.type === 'crate' && g.time < s.emptyUntil);
  assert.strictEqual(empty.length, 2);
  assert(empty.every(c => ['patty', 'bun', 'lettuce', 'tomato'].includes(c.crateItem)));
  waitSeconds(g, p, EVENTS.strike.duration + 0.2);
  assert.strictEqual(g.stations.filter(s => s.type === 'crate' && g.time < s.emptyUntil).length, 0);

  const q = gameWith(126, ['a']);
  q.g.level = 9; q.g.money = 500;
  buyPlace(q.g, q.p, 'belt', 4, 6, 4, 7);
  const hob = q.g.stations.find(s => s.type === 'hob');
  runEvent(q.g, q.p, 'powerCut');
  hob.item = { k: 'patty' };
  const belt = q.g.stations.find(s => s.type === 'belt');
  belt.item = { k: 'bun' }; belt.prog = 0.5;
  waitSeconds(q.g, q.p, 5);
  assert.strictEqual(hob.item.cook || 0, 0, 'no cooking in a power cut');
  assert.strictEqual(belt.prog, 0.5, 'belts stop');
  waitSeconds(q.g, q.p, EVENTS.powerCut.duration);
  assert(hob.item.cook > 0, 'power back on');
});

test('events: coach party, critics night and VIP night bring the right guests', () => {
  const { g, p } = gameWith(127, ['a']);
  g.level = 9;
  runEvent(g, p, 'coach');
  assert.strictEqual(g.customers.length, 4);
  const c2 = gameWith(128, ['a']);
  c2.g.level = 9;
  runEvent(c2.g, c2.p, 'critics');
  assert.strictEqual(c2.g.customers.filter(c => c.type === 'critic').length, 2);
  const v = gameWith(129, ['a']);
  v.g.level = 9;
  runEvent(v.g, v.p, 'vipNight');
  for (const c of v.g.customers) c.patience = c.maxPatience = 999;   // keep them around to count
  waitSeconds(v.g, v.p, 45);
  assert.strictEqual(v.g.customers.filter(c => c.vip).length, 3);
});

// ---- venues milestone 2: table caps and seating -------------------------------------
test('table cap: you can buy tables up to the venue maximum, then no more', () => {
  const g = Sim.createGame({ seed: 131, venue: 'greasySpoon' });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  g.level = 10; g.money = 1000; g.goalIndex = 999;
  assert.strictEqual(Sim.shopCap(g, 'table'), VENUES.greasySpoon.maxTables);
  assert.strictEqual(Sim.tableCount(g), 3);
  buyPlace(g, p, 'table', 11, 7, 12, 7);
  assert.strictEqual(Sim.tableCount(g), 4);
  assert(!Sim.buy(g, 'a', 'table'), 'at the cap');
  assert.strictEqual(p.held, null);
  // Moving an existing table is still fine.
  walkTo(g, p, g.stations.find(s => s.type === 'table' && s.x === 11 && s.y === 7)); press(g, p);
  assert.strictEqual(p.held.type, 'table');
  assert(!Sim.buy(g, 'a', 'table'));
  const truck = Sim.createGame({ seed: 132, venue: 'foodTruck' });
  Sim.addPlayer(truck, 'a', 'A', 0); truck.level = 10; truck.money = 1000;
  assert(!Sim.buy(truck, 'a', 'table'), 'no tables in a food truck');
});

test('pairs share a table, order separately, and leave together leaving the table to clear', () => {
  const g = Sim.createGame({ seed: 133 });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  g.goalIndex = 999;
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  // Force a pair.
  g.map = Object.assign({}, g.map, { partyWeights: { 2: 1 } });
  const [a, b] = Sim.spawnParty(g);
  assert(a && b && a.partyId === b.partyId);
  a.order = { dish: 'burger', tops: [] };
  b.order = { dish: 'burger', tops: ['choppedTomato'] };
  untilState(g, p, a, 'waiting'); untilState(g, p, b, 'waiting');
  assert.strictEqual(a.table, b.table, 'same table');
  const table = tableOf(g, a);
  walkTo(g, p, table);
  p.held = { k: 'plate', parts: ['bun', 'cookedPatty', 'choppedTomato'] }; press(g, p);
  assert.strictEqual(b.state, 'eating', 'the tomato plate went to the person who ordered it');
  assert.strictEqual(a.state, 'waiting');
  p.held = burgerPlate(); press(g, p);
  assert.strictEqual(a.state, 'eating');
  waitSeconds(g, p, CONFIG.eatTime + 0.2);
  assert(a.state === 'leaving' && b.state === 'leaving', 'they leave together');
  assert.strictEqual(table.item.k, 'dirtyPlate');
  assert(!g.customers.some(c => c.table === table.id && c.state !== 'leaving'));
  // A pair takes one table; parties never exceed 2 for now, and the truck only has singles.
  const t = Sim.createGame({ seed: 134, venue: 'foodTruck' });
  Sim.addPlayer(t, 'a', 'A', 0); Sim.openDoors(t); t.day.nextArrival = Infinity;
  for (let i = 0; i < 20; i++) { t.customers = []; assert.strictEqual(Sim.spawnParty(t).length, 1); }
});

test('tables seat two face to face: singles leave the other seat empty, pairs take both', () => {
  for (const key in VENUES) {
    const g = Sim.createGame({ seed: 1, venue: key });
    for (const t of g.stations.filter(s => s.type === 'table' && s.look !== 'window')) {
      assert.strictEqual(t.seats.length, 2, `${key}: table at ${t.x},${t.y}`);
      assert(t.seats[0].seat[1] === t.y - 1 && t.seats[1].seat[1] === t.y + 1 && t.seats[1].below, `${key}: 12 and 6 o'clock`);
    }
  }
  const g = Sim.createGame({ seed: 135 });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  g.goalIndex = 999;
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  const solo = Sim.spawnCustomer(g, { type: 'normal' });
  untilState(g, p, solo, 'waiting');
  assert.strictEqual(Sim.seatOf(tableOf(g, solo), solo), tableOf(g, solo).seats[0], 'a single takes the top seat');
  assert(!Sim.freeTables(g).includes(tableOf(g, solo)), 'and has the table to themselves');
  g.map = Object.assign({}, g.map, { partyWeights: { 2: 1 } });
  const [a, b] = Sim.spawnParty(g);
  untilState(g, p, a, 'waiting'); untilState(g, p, b, 'waiting');
  const t = tableOf(g, a);
  assert.notStrictEqual(Sim.seatOf(t, a).seat.join(), Sim.seatOf(t, b).seat.join(), 'a pair sits on opposite seats');
  // A newly placed table brings both chairs when there's room.
  const h = Sim.createGame({ seed: 136 });
  Sim.addPlayer(h, 'a', 'A', 0);
  assert(Sim.canPlace(h, 13, 5, 'table').ok, 'tables can go anywhere free in the dining room');
  // Old saves get the opposite chair added.
  const old = VENUES.diner.rows.map(r => r.replace(/h/g, '.'));
  old[2] = VENUES.diner.rows[2]; old[7] = VENUES.diner.rows[7];
  const back = Sim.createGame({ lobby: true });
  Sim.loadState(back, { saveVersion: 6, venue: 'diner', venues: { diner: { unlocked: true, layout: old } }, layout: old, level: 8 });
  assert.strictEqual(back.venues.diner.layout.join(), VENUES.diner.rows.join(), 'chairs added below the old tables');
});

// ---- venues milestone 3: the waiting room ---------------------------------------------
test('waiting room: full tables mean waiting, a full room turns parties away, waiting runs out of patience', () => {
  const g = Sim.createGame({ seed: 140, venue: 'greasySpoon' });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  g.goalIndex = 999;
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  g.map = Object.assign({}, g.map, { partyWeights: { 1: 1 } });
  for (const t of g.stations.filter(s => s.type === 'table')) t.item = { k: 'dirtyPlate' };   // every table busy
  const cap = Sim.waitingCapacity(g);
  assert.strictEqual(cap, VENUES.greasySpoon.waitingRoomCapacity);
  for (let i = 0; i < cap; i++) assert.strictEqual(Sim.spawnParty(g).length, 1);
  tick(g, p, {}, 2);
  assert.strictEqual(Sim.waitingParties(g).length, cap, 'they wait');
  const stars = g.reputation;
  assert.strictEqual(Sim.spawnParty(g).length, 0, 'full house');
  assert.strictEqual(g.day.stats.turnedAway, 1);
  assert(Math.abs(g.reputation - (stars - CONFIG.turnAwayPenalty)) < 1e-9);
  // Nothing can be built on the waiting room.
  assert(!Sim.canPlace(g, 12, 6, 'plant').ok);
  // Waiting patience drains at the waiting rate.
  const c = g.customers[0], before = c.patience;
  waitSeconds(g, p, 1);
  assert(Math.abs(before - c.patience - CONFIG.waitingPatienceRate) < 0.05, 'slower than seated ' + (before - c.patience));
  // Free a table: strictly the front of the queue gets it.
  const t = g.stations.find(s => s.type === 'table'); t.item = null;
  tick(g, p, {}, 2);
  assert.strictEqual(c.state, 'walking');
  assert.strictEqual(Sim.waitingParties(g).length, cap - 1);
  // The rest run out of patience and leave, one walkout each.
  const walk = g.day.stats.walkouts;
  for (const m of g.customers) if (m.state === 'queue') m.patience = 0.01;
  tick(g, p, {}, 2);
  assert.strictEqual(g.day.stats.lostWaiting, cap - 1);
  assert.strictEqual(g.day.stats.walkouts, walk + cap - 1);
});

test('waiting room: a pair leaves together, nobody jumps the queue, closing sends waiters home without penalty', () => {
  const g = Sim.createGame({ seed: 141, venue: 'greasySpoon' });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  g.goalIndex = 999;
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  const tables = g.stations.filter(s => s.type === 'table');
  for (const t of tables) t.item = { k: 'dirtyPlate' };
  g.map = Object.assign({}, g.map, { partyWeights: { 2: 1 } });
  const [a, b] = Sim.spawnParty(g);
  g.map = Object.assign({}, g.map, { partyWeights: { 1: 1 } });
  const [solo] = Sim.spawnParty(g);
  // Make every table one-seat except none: free a table but block its bottom chair, so the pair can't use it.
  tick(g, p, {}, 2);
  a.patience = 0.01;
  tick(g, p, {}, 2);
  assert(a.state === 'leaving' && b.state === 'leaving', 'the whole party gives up together');
  assert.strictEqual(g.day.stats.lostWaiting, 1);
  assert.strictEqual(solo.state, 'queue');
  // Closing: waiters go home, no stars lost.
  const stars = g.reputation;
  g.phaseTime = 0.01;
  tick(g, p, {}, 2);
  assert.strictEqual(solo.state, 'leaving');
  assert.strictEqual(g.reputation, stars);
  assert.strictEqual(g.day.stats.lostWaiting, 1);
});

// ---- venues milestone 4: parties and joined tables ------------------------------------
test('joined tables: a party of 3 sits at 2 joined tables, all 3 orders are served, and they leave together', () => {
  const g = Sim.createGame({ seed: 150, venue: 'greasySpoon' });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  g.goalIndex = 999; g.level = 10;
  Sim.startGame(g);
  // Move the table at (12,3) next to the one at (10,3).
  const t12 = g.stations.find(s => s.type === 'table' && s.x === 12 && s.y === 3);
  walkTo(g, p, t12); press(g, p);
  assert.strictEqual(p.held.type, 'table');
  p.x = 11.5; p.y = 5.5; p.fx = 0; p.fy = -1;
  tick(g, p, {}, 1);
  // Facing (11,4) won't do: place it at (11,3) from (11,4)... stand below the spot instead.
  assert(Sim.placeHeld(g, p, 11, 3), 'placed beside the other table');
  const a = g.stations.find(s => s.type === 'table' && s.x === 10 && s.y === 3);
  assert.strictEqual(Sim.neighbourTables(g, a).length, 1);
  assert.strictEqual(Sim.toggleJoin(g, a), 'join');
  assert.strictEqual(g.tiles[3 * g.w + 10] + g.tiles[3 * g.w + 11], 'JJ');
  assert(Sim.tableUnits(g).some(u => u.length === 2));
  // Joins are part of the layout, so they save and reach clients.
  const back = Sim.createGame({ lobby: true, venue: 'greasySpoon' });
  Sim.loadState(back, wire(Sim.serialiseState(g)));
  assert(back.layout[3].includes('JJ'));
  const client = Sim.createGame({ lobby: true, venue: 'greasySpoon' });
  Sim.applySnapshot(client, wire(Sim.snapshot(g)));
  assert(client.stations.find(s => s.x === 10 && s.y === 3).joined);
  // A single picks a lone table (smallest fit), not the joined pair.
  Sim.finishBuild(g);
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  g.map = Object.assign({}, g.map, { partyWeights: { 1: 1 } });
  const [solo] = Sim.spawnParty(g);
  tick(g, p, {}, 2);
  assert(!g.stations[solo.table].joined, 'smallest free unit');
  // A party of 3: two joined tables.
  g.map = Object.assign({}, g.map, { partyWeights: { 3: 1 } });
  const party = Sim.spawnParty(g);
  assert.strictEqual(party.length, 3);
  party.forEach((m, i) => { m.order = { dish: 'burger', tops: i === 1 ? ['choppedTomato'] : [] }; delete m.left; });
  for (const m of party) untilState(g, p, m, 'waiting');
  const tables = new Set(party.map(m => m.table));
  assert.strictEqual(tables.size, 2, 'spread over both joined tables');
  for (const id of tables) assert(g.stations[id].joined);
  assert(party.every(m => m.maxPatience === party[0].maxPatience), 'one shared patience bar');
  const money = g.money;
  for (const m of party) {
    const t = g.stations[m.table];
    walkTo(g, p, t);
    p.held = m.order.tops.length ? { k: 'plate', parts: ['bun', 'cookedPatty', 'choppedTomato'] } : burgerPlate();
    press(g, p);
    assert.strictEqual(m.state, 'eating');
  }
  assert(g.money - money > CONFIG.partyBonusPerPerson * 3, 'the whole-party bonus was paid');
  waitSeconds(g, p, CONFIG.eatTime + 0.3);
  assert(party.every(m => m.state === 'leaving'), 'they leave together');
  for (const id of tables) assert.strictEqual(g.stations[id].item.k, 'dirtyPlate');
});

test('joined tables: unjoin, moving a joined table needs a second press and unjoins it, a big party waits for a big table', () => {
  const g = Sim.createGame({ seed: 151, venue: 'diner' });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  g.goalIndex = 999; g.level = 10;
  Sim.startGame(g);
  // No joined tables: parties are capped at what a single table seats.
  Sim.finishBuild(g); Sim.openDoors(g); g.day.nextArrival = Infinity;
  for (let i = 0; i < 10; i++) { g.customers = []; assert(Sim.spawnParty(g).length <= 2); }
  g.customers = [];
  g.phase = 'build';
  // Make a joined pair: move (15,3) to (13,3) beside (12,3).
  const t15 = g.stations.find(s => s.type === 'table' && s.x === 15 && s.y === 3);
  walkTo(g, p, t15); press(g, p);
  assert(Sim.placeHeld(g, p, 13, 3));
  const t12 = g.stations.find(s => s.x === 12 && s.y === 3);
  assert.strictEqual(Sim.toggleJoin(g, t12), 'join');
  assert.strictEqual(Sim.toggleJoin(g, g.stations.find(s => s.x === 13 && s.y === 3)), 'unjoin');
  assert.strictEqual(g.tiles[3 * g.w + 12], 'T');
  Sim.toggleJoin(g, g.stations.find(s => s.x === 12 && s.y === 3));
  // Lifting a joined table: first press warns, second lifts and unjoins its partner.
  walkTo(g, p, g.stations.find(s => s.x === 13 && s.y === 3));
  press(g, p);
  assert.strictEqual(p.held, null, 'first press only warns');
  press(g, p);
  assert.strictEqual(p.held.type, 'table');
  assert.strictEqual(p.held.tile, 'T');
  assert.strictEqual(g.tiles[3 * g.w + 12], 'T', 'the partner is unjoined');
  assert(Sim.placeHeld(g, p, 13, 3));
  Sim.toggleJoin(g, g.stations.find(s => s.x === 12 && s.y === 3));
  // A party of 4 waits for the joined unit even with single tables free.
  Sim.finishBuild(g); Sim.openDoors(g); g.day.nextArrival = Infinity;
  for (const s of g.stations) if (s.type === 'table' && s.joined && s.x === 12) s.item = { k: 'dirtyPlate' };
  g.map = Object.assign({}, g.map, { partyWeights: { 4: 1 } });
  const four = Sim.spawnParty(g);
  assert.strictEqual(four.length, 4);
  tick(g, p, {}, 2);
  assert(four.every(m => m.state === 'queue'), 'waiting for the joined tables');
  g.stations.find(s => s.x === 12 && s.y === 3).item = null;
  tick(g, p, {}, 2);
  assert(four.every(m => m.state === 'walking'));
  // Shared patience: when it runs out the whole party walks out.
  for (const m of four) untilState(g, p, m, 'waiting');
  four[0].patience = 0.01;
  const walk = g.day.stats.walkouts;
  tick(g, p, {}, 2);
  assert(four.every(m => m.state === 'leaving'));
  assert.strictEqual(g.day.stats.walkouts, walk + 1);
});

test('chairs: walk-through, corners still seat two, joined groups seat 12s then 6s then the ends', () => {
  const g = Sim.createGame({ seed: 152, venue: 'diner' });
  Sim.addPlayer(g, 'a', 'A', 0);
  // Players walk over chairs; tables stay solid.
  const t = g.stations.find(s => s.type === 'table');
  assert(!Sim.isSolid(g, t.seats[0].seat[0], t.seats[0].seat[1]), 'chairs are walkable');
  assert(Sim.isSolid(g, t.x, t.y));
  // Clear the dining room, then try layouts (bottom wall is row 11, the dining room starts at x 11).
  Sim.setTiles(g, g.stations.filter(s => s.type === 'table').map(s => [s.x, s.y, '.']));
  const seats = (...xy) => xy.flatMap(([x, y]) => Array.from(g.stations.find(o => o.x === x && o.y === y).seats, e => e.seat.join())).sort().join(' ');
  // A lone table in the bottom-left corner: 12 o'clock and 3 o'clock.
  Sim.setTiles(g, [[11, 10, 'T']]);
  assert.strictEqual(seats([11, 10]), ['11,9', '12,10'].sort().join(' '));
  // Two joined tables against the bottom wall: two at 12, one at each end.
  Sim.setTiles(g, [[11, 10, '.'], [13, 10, 'J'], [14, 10, 'J']]);
  assert.strictEqual(seats([13, 10], [14, 10]), ['13,9', '14,9', '12,10', '15,10'].sort().join(' '));
  // Pushed into the bottom-left corner: two at 12 and one at 3, so three seats.
  Sim.setTiles(g, [[13, 10, '.'], [14, 10, '.'], [11, 10, 'J'], [12, 10, 'J']]);
  assert.strictEqual(seats([11, 10], [12, 10]), ['11,9', '12,9', '13,10'].sort().join(' '));
  // In the open, two joined tables seat four: two at 12, two at 6.
  Sim.setTiles(g, [[11, 10, '.'], [12, 10, '.'], [13, 2, 'J'], [14, 2, 'J']]);
  assert.strictEqual(seats([13, 2], [14, 2]), ['13,1', '14,1', '13,3', '14,3'].sort().join(' '));
  // Nothing goes right inside a door.
  assert(!Sim.canPlace(g, 18, 6, 'table').ok, 'blocks the door');
  assert(Sim.canPlace(g, 16, 8, 'table').ok);
});

// ---- venues milestone 5: venue select, caps and the Maxed badge ------------------------
test('every shop item has a cap per venue; a venue is Maxed when everything unlocked is at its cap', () => withRealLayouts(() => {
  const g = Sim.createGame({ seed: 160, venue: 'greasySpoon' });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  assert.strictEqual(g.stations.filter(s => s.type === 'table').length, 2, 'two tables to start');
  g.level = 1; g.money = 5000;
  // At level 1 the shop has sinks and racks. Buy racks up to the cap.
  const cap = Sim.shopCap(g, 'rack');
  while (Sim.itemCount(g, 'rack') < cap) {
    assert(Sim.buy(g, 'a', 'rack'));
    p.held = null;                                   // (bin it: we only care about counting what's placed)
    Sim.setTiles(g, [[2 + Sim.itemCount(g, 'rack'), 4, 'R']]);
  }
  assert(!Sim.buy(g, 'a', 'rack'), 'at the cap');
  assert(!Sim.venueSummary(g).greasySpoon.maxed);
  const sinkCap = Sim.shopCap(g, 'sink');
  while (Sim.itemCount(g, 'sink') < sinkCap) Sim.setTiles(g, [[2 + Sim.itemCount(g, 'sink'), 6, 'S']]);
  assert(Sim.venueMaxed(g, 'greasySpoon'), 'everything unlocked at level 1 is at its cap');
  assert(Sim.venueSummary(g).greasySpoon.maxed);
  assert.strictEqual(Sim.venueSummary(g).greasySpoon.tables, 2);
  g.level = 2;
  assert(!Sim.venueMaxed(g, 'greasySpoon'), 'new unlocks mean more to buy');
  // Caps differ by venue.
  assert(Sim.shopCap(g, 'hob', 'bigRestaurant') > Sim.shopCap(g, 'hob', 'greasySpoon'));
  assert.strictEqual(Sim.shopCap(g, 'hatch', 'foodTruck'), 0);
  // Clients see the badge and table counts in snapshots.
  const client = Sim.createGame({ lobby: true, venue: 'greasySpoon' });
  Sim.applySnapshot(client, wire(Sim.snapshot(g)));
  assert.strictEqual(Sim.venueSummary(client).greasySpoon.tables, 2);
}));

test('old saves: a venue nobody has changed gets the new starting layout; changed ones are kept', () => withRealLayouts(() => {
  const old = rows => { const r = rows.map(x => x.split('')); r[3][12] = 'T'; return r.map(x => x.join('')); };
  const changed = old(VENUES.greasySpoon.rows); changed[6] = changed[6].slice(0, 2) + 'H' + changed[6].slice(3);
  const g = Sim.createGame({ lobby: true });
  Sim.loadState(g, { saveVersion: 8, venue: 'greasySpoon', layout: changed,
    venues: { greasySpoon: { unlocked: true, layout: changed }, diner: { unlocked: false, layout: LEGACY_ROWS.diner } } });
  assert.strictEqual(g.layout.join(), changed.join(), 'changed: kept');
  assert.strictEqual(g.venues.diner.layout.join(), VENUES.diner.rows.join(), 'untouched: new layout');
}));

// ---- venues milestone 6: the venues play differently ---------------------------------
test('venues: bigger venues are busier and less patient; level makes each venue busier', () => withRealLayouts(() => {
  const gap = (venue, level) => {
    const g = Sim.createGame({ seed: 170, venue });
    Sim.addPlayer(g, 'a', 'A', 0);
    g.level = level;
    let t = 0;
    for (let i = 0; i < 400; i++) t += Sim.arrivalGap(g);
    return t / 400;
  };
  assert(gap('greasySpoon', 1) > gap('diner', 7) && gap('diner', 7) > gap('bigRestaurant', 10), 'busier as you go up');
  assert(gap('greasySpoon', 8) < gap('greasySpoon', 1), 'going back is never trivial');
  const pat = venue => {
    const g = Sim.createGame({ seed: 171, venue });
    Sim.addPlayer(g, 'a', 'A', 0);
    return Sim.spawnCustomer(g, { type: 'normal' }).maxPatience;
  };
  assert(pat('foodTruck') < pat('greasySpoon'), 'the truck is hectic');
}));

test('food truck: a group is one ticket for several plates, and takeaway customers leave quickly', () => withRealLayouts(() => {
  const g = Sim.createGame({ seed: 172, venue: 'foodTruck' });
  const p = Sim.addPlayer(g, 'a', 'A', 0);
  g.goalIndex = 999;
  Sim.openDoors(g); g.day.nextArrival = Infinity;
  g.map = Object.assign({}, g.map, { partyWeights: { 3: 1 } });
  const group = Sim.spawnParty(g);
  assert.strictEqual(group.length, 1, 'one customer at the window');
  const c = group[0];
  assert.strictEqual(c.left, 3);
  c.type = 'normal'; c.order = { dish: 'burger', tops: [] };
  untilState(g, p, c, 'waiting');
  const w = g.stations[c.table];
  assert.strictEqual(w.look, 'window');
  walkTo(g, p, w);
  for (let i = 0; i < 3; i++) { p.held = burgerPlate(); press(g, p); }
  assert.strictEqual(c.state, 'eating', 'all three plates served');
  waitSeconds(g, p, CONFIG.eatTime * CONFIG.takeawayEatFactor + 0.3);
  assert.strictEqual(c.state, 'leaving', 'takeaway: off they go');
}));

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
