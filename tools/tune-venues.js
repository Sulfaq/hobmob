// Venue tuning: plays a full service day in every venue with a stand-in kitchen and reports how busy it was.
// Usage: node tools/tune-venues.js [chefs] [secondsPerPlate]
// The stand-in kitchen: each chef finishes a plate every secondsPerPlate seconds and serves the customer
// who has waited longest; they clear a dirty table (4s) first when people are queuing or nothing needs cooking. That's rough, but it's the same for every venue, so the venues can be compared.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = html.match(/<script id="sim">([\s\S]*?)<\/script>/)[1];
const { Sim, CONFIG, VENUES } = vm.runInNewContext(src + '\n;({ Sim, CONFIG, VENUES })', { TextEncoder, TextDecoder, btoa, atob });

const chefs = +process.argv[2] || 2, perPlate = +process.argv[3] || 14;
const DT = 1 / CONFIG.tickRate;

// Fill a venue's dining room the way players might mid-game: about two thirds of the table cap,
// as joined pairs (4 seats) spaced through the room, plus single tables where pairs don't fit.
function furnish(g) {
  const want = Math.round(g.map.maxTables * 0.66);
  Sim.setTiles(g, g.stations.filter(s => s.type === 'table' && s.look !== 'window').map(s => [s.x, s.y, '.']));
  for (let y = 2; y < g.h - 2; y += 3) {
    for (let x = g.diningStartX + 1; x < g.w - 2; x += 3) {
      if (Sim.tableCount(g) >= want) return;
      if (!Sim.canPlace(g, x, y, 'table').ok) continue;
      Sim.setTiles(g, [[x, y, 'T']]);
      if (Sim.tableCount(g) < want && Sim.canPlace(g, x + 1, y, 'table').ok) Sim.setTiles(g, [[x, y, 'J'], [x + 1, y, 'J']]);
    }
  }
}

function playDay(key, level, day, furnished) {
  const g = Sim.createGame({ seed: 1000 + level * 7 + day, venue: key });
  for (let i = 0; i < chefs; i++) Sim.addPlayer(g, 'c' + i, 'C' + i, i);
  g.goalIndex = 999;
  g.level = level; g.dayNum = day;
  if (furnished) furnish(g);
  Sim.finishBuild(g);
  Sim.openDoors(g);
  const busy = new Array(chefs).fill(0);
  let waitSum = 0, samples = 0, waitingTicks = 0, people = 0;
  const seen = new Set();
  while (g.phase === 'service' || g.phase === 'closing') {
    for (const c of g.customers) if (!seen.has(c.id)) { seen.add(c.id); people += c.left || 1; }
    // Each free chef serves the longest-waiting seated customer.
    for (let i = 0; i < chefs; i++) {
      busy[i] = Math.max(0, busy[i] - DT);
      if (busy[i] > 0) continue;
      const c = g.customers.filter(c => c.state === 'waiting').sort((a, b) => a.patience / a.maxPatience - b.patience / b.maxPatience)[0];
      // Clear a dirty table when there's nothing to cook or people are queuing for a table (takes 4s).
      const dirty = g.stations.find(t => t.type === 'table' && t.item && t.item.k === 'dirtyPlate');
      if (dirty && (!c || Sim.waitingParties(g).length)) { dirty.item = null; busy[i] = 4; continue; }
      if (!c) continue;
      busy[i] = perPlate;
      if (c.left > 1) { c.left--; continue; }
      c.state = 'eating'; c.t = 0;
      g.day.stats.served++;
    }
    for (const id in g.players) g.players[id].input = { mx: 0, my: 0, grabSeq: g.players[id].lastGrabSeq, use: false };
    Sim.step(g, DT);
    if (g.phase === 'service') {
      const n = Sim.waitingParties(g).length;
      waitSum += n; samples++; if (n > 0) waitingTicks++;
    }
    if (g.phase === 'gameover') break;
  }
  const st = g.day.stats;
  return { arrivals: st.arrivals, people, served: st.served, walkouts: st.walkouts, lost: st.lostWaiting, away: st.turnedAway,
    avgWaiting: waitSum / samples, someoneWaiting: waitingTicks / samples, tables: Sim.tableCount(g), gameover: g.phase === 'gameover' };
}

console.log(`Stand-in kitchen: ${chefs} chef(s), ${perPlate}s per plate. Day 3, ${CONFIG.dayLength}s of service.`);
console.log('venue           level tables  people served walkouts gaveUp turnedAway  avgWaiting  someoneWaiting');
for (const key in VENUES) {
  const v = VENUES[key];
  for (const level of [v.unlockLevel, v.unlockLevel + 3]) {
    const r = playDay(key, level, 3, true);
    console.log(`${v.name.padEnd(16)}${String(level).padStart(5)} ${String(r.tables).padStart(6)} ${String(r.people).padStart(7)} ${String(r.served).padStart(6)} ${String(r.walkouts).padStart(8)} ${String(r.lost).padStart(6)} ${String(r.away).padStart(10)} ${r.avgWaiting.toFixed(2).padStart(11)} ${(Math.round(r.someoneWaiting * 100) + '%').padStart(15)}${r.gameover ? '  (closed down)' : ''}`);
  }
}
