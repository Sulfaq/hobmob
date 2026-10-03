# Hob Mob

A co-op restaurant game for up to 4 chefs, played in the browser on PC and phone.
Cook, plate and serve before your customers run out of patience.

**Play:** open the GitHub Pages link for this repo, create a room, and send friends the invite link
(or the 4-letter room code).

## Controls

- **PC:** WASD / arrows to move · E / Space to grab or drop · hold F / Shift to chop or wash
- **Phone (landscape):** left thumb joystick · GRAB / DROP button · hold USE

## How it's built

- One self-contained `index.html` (game, PeerJS and styles all inline), so it hosts free as a static site.
- Host-authoritative multiplayer over WebRTC via [PeerJS](https://peerjs.com) (MIT); the only network
  dependency is the free PeerJS matchmaking server.
- All tuning numbers live in the `CONFIG` object at the top of the game script.

## How a day works

1. **Kitchen setup** (no timer): buy stations in the shop, pick any station up with GRAB and put it
   somewhere else, or drop it on the bin to sell it. The host presses *Start day*.
2. **Prep** (30 s), then **service** (2–10 minutes, picked by the host in the menu).
3. **Summary**: stats, then everyone votes on an upgrade.

Lose all your stars and the restaurant closes. Score = days survived × 100 + money earned.

## Deploying (free)

**GitHub Pages** (how this repo is hosted): push to `main`, then in the repo go to
*Settings → Pages → Build and deployment*, choose *Deploy from a branch*, `main`, `/ (root)`.
The game appears at `https://<user>.github.io/<repo>/` a minute later, and every push redeploys.

**Cloudflare Pages**: in the Cloudflare dashboard go to *Workers & Pages → Create → Pages →
Upload assets*, and drag in `index.html` (or connect this GitHub repo with no build command and
output directory `/`). You get a free `https://<name>.pages.dev` link.

Either way there is no server to run: the only online service used is the free PeerJS
matchmaking server, which connects players directly to each other.

## Development

```bash
node tests/sim.test.js          # simulation tests (no browser needed)
node tools/inline-vendor.js     # re-inline vendor/peerjs after updating it
py -m http.server 8000          # serve locally, then open http://localhost:8000
```
