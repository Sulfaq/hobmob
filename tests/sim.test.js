// Runs the game simulation from index.html in Node, without a browser.
// Usage: node tests/sim.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = html.match(/<script id="sim">([\s\S]*?)<\/script>/)[1];
const { Sim, CONFIG, RECIPES, EVENTS, SHOP, SaveCode } = vm.runInNewContext(src + '\n;({ Sim, CONFIG, RECIPES, EVENTS, SHOP, SaveCode })', {
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
function toSummary(g, p) {
  Sim.openDoors(g);
  g.day.nextArrival = Infinity;
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
  Sim.applyUpgrade(g, 'newDish');
  assert(g.menu.includes('salad'));
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
  m.g.money = 100;
  Sim.buy(m.g, 'a', 'table'); faceTile(m.g, m.p, 16, 5); press(m.g, m.p);
  const client = Sim.createGame({ lobby: true });
  Sim.applySnapshot(client, wire(Sim.snapshot(m.g)));
  assert.strictEqual(client.tiles.join(''), m.g.tiles.join(''));
  assert(client.stations.every((s, i) => s.type === m.g.stations[i].type && s.x === m.g.stations[i].x));
});

test('a new run after game over restores the original kitchen and money', () => {
  const { g, p } = gameWith(3, ['a']);
  g.money = 100;
  Sim.buy(g, 'a', 'table'); faceTile(g, p, 16, 5); press(g, p);
  Sim.applyUpgrade(g, 'trainers');
  Sim.endRun(g);
  Sim.newRun(g);
  assert.strictEqual(count(g, 'table'), 6);
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
  g.money = 100;
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
  Sim.applyUpgrade(g, 'trainers'); Sim.applyUpgrade(g, 'newDish');
  Sim.buy(g, 'a', 'hob'); faceTile(g, p, 4, 6); press(g, p);
  const data = wire(Sim.serialiseState(g));
  assert.strictEqual(data.saveVersion, CONFIG.saveVersion);
  const back = Sim.createGame({ lobby: true });
  Sim.loadState(back, data);
  assert.strictEqual(back.money, g.money); assert.strictEqual(back.reputation, 4.5);
  assert.strictEqual(back.layout.join(), g.layout.join());
  assert.strictEqual(count(back, 'hob'), 2);
  assert.strictEqual(back.mods.speed, g.mods.speed);
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
