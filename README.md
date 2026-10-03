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

## Development

```bash
node tests/sim.test.js          # simulation tests (no browser needed)
node tools/inline-vendor.js     # re-inline vendor/peerjs after updating it
py -m http.server 8000          # serve locally, then open http://localhost:8000
```
