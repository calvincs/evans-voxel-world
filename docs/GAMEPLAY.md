# Player's Guide

Everything you can do in Evan's Voxel World. New here? The [README](../README.md)
gets the game running; this guide covers what to do once you're in.

## Contents

- [Signing in & your profile](#signing-in--your-profile)
- [Worlds](#worlds)
- [Controls](#controls)
- [Building & the inventory](#building--the-inventory)
- [Special blocks](#special-blocks)
- [Water](#water)
- [Creatures](#creatures)
- [The minimap](#the-minimap)
- [Rewind (snapshots)](#rewind-snapshots)
- [Sound & music](#sound--music)
- [Voice chat](#voice-chat)

## Signing in & your profile

On launch you **sign in or create an account** (username + password). From the
world menu, open **⚙ Profile** to change your display name, pick your character
color, or set a new password. Only you (while signed in) can edit your own
profile.

Forgot a password? Whoever runs the server can reset it — see
[Hosting → Resetting a password](HOSTING.md#resetting-a-password).

## Worlds

After signing in you get a **menu** to create a new named world or load one you
can see. Terrain is generated from a random **seed**, so every world is
different — hills, water, beaches, trees, and a village.

- **Ownership** — whoever creates a world owns it. Only the owner can rename
  it, change its visibility, delete it (🗑), or rewind it.
- **Public / private** — worlds are **public** by default (everyone on the LAN
  sees them); toggle the 🌐/🔒 button to make one private (only you see it).
- **Claim** — worlds created before accounts existed show as *Unclaimed*;
  press **Claim** to become their owner.

## Controls

| Input | Action |
|-------|--------|
| `W A S D` | move |
| Mouse | look |
| `Space` | jump |
| `Shift` | run |
| Left click | break a block |
| Right click | place a block |
| `1`–`8` / scroll | choose a hotbar block |
| `E` | inventory (pick any block) |
| `V` | first / third-person view |
| `N` / tap the map | resize / hide the minimap |
| `M` | sound on/off (music **and** effects; voice chat stays on) |
| `🎙️` / hold `T` | join voice / talk |
| `Esc` | pause |

Touch controls appear automatically on tablets and phones.

## Building & the inventory

Press **E** for the **inventory** — a picker for *every* block (including ones
not on your hotbar). Click a block to load it into your currently-selected
hotbar slot. It's **creative**: blocks never run out, and everything (including
the specials like Mossy Cobble, Marble and Rainbow) is simply available — no
crafting needed.

The hotbar has lots of blocks to start with — grass, stone, planks, wool, gold,
diamond, pumpkin, snow, and more.

## Special blocks

### TNT & Firestone

- **TNT** — place it like any block.
- **Firestone** (the flint-and-steel icon, last hotbar slot) — select it and
  **right-click a TNT block** to light it. It flashes, then **explodes** after
  about a second, blowing a crater in the terrain with debris, a boom, and a
  camera shake. TNT next to TNT **chain-reacts**.

The Firestone strikes more than TNT:

- **Pumpkins** — strike one and its carved face lights up like a
  **jack-o'-lantern** (a real light source at night, like glowstone); strike
  it again to snuff it out.
- **Proximity Mines** and **Elevators** — see below.

### Glowstone

A warm ember-stone that **glows and gives off light at night**, with a gentle
flame-like flicker. Place a few to light up a build after dark; nearby blocks
are lit by real warm point-lights that follow the closest glowstones to you.

### Doors

Place a **Door** and a proper two-block-tall door stands up, facing you.
**Click a door to swing it open or shut** — no tool needed, whatever you're
holding. Closed doors are solid and creatures can't work a handle, so a shut
door keeps the night's wolves and spiders outside your base. An open door is a
real doorway: walk (and aim) straight through the opening — only the
swung-aside panel answers a click. Breaking either half removes the whole
door, and doors persist, sync to friends, and rewind like any other block.

### Proximity Mines

Firestone strikes cycle a placed mine through its modes in escalating danger:
**off → 🟢 MONSTER TRAP → 🟡 watch others → 🔴 watch EVERYONE → off**.

Arming takes **5 seconds** (walk away!); once live, anything the mine watches
sets it off **instantly** — half the crater of TNT, but the same lethal blast.

- The **green eye** is the monster trap: only the creatures that can hurt you
  (wolves, spiders, squid) set it off — people and pets walk over it safely.
  Perfect for defending a base at night.
- The **yellow eye** watches all creatures and *other* players (never you).
- The **red eye** watches **everyone, you included**.

Mines are watched by the **server**: once live they stay live — leave, come
back tomorrow, or let a friend wander in first — and they still remember whose
they are.

### Elevators

The **Up Elevator** (steel-blue) floats straight up when you stand on it; the
**Side Elevator** (tan) glides sideways.

- Firestone strikes set the travel distance **1–10**, shown right on the block.
- The **11th strike switches direction** and restarts at 1: vertical flips
  **⬆ up / ⬇ down** (basement rides!), horizontal cycles **⬆ forward → ➡ right
  → ⬇ back → ⬅ left** — all relative to the way *you* are facing when you hop
  on, matching the arrow painted on the block.
- Hop off and the block comes home and lands by itself. Returning platforms
  have a garage-door-style **safety sensor**: one will never land on (or in!)
  a player — it hovers overhead and waits for them to step aside.

## Water

**Water flows.** Pour a water block into a hole and it streams downhill to the
deepest spot; keep pouring and the basin fills up layer by layer. Break a
pond's wall and it drains along the channel you dug; break the floor beneath
it and it falls through.

Poured water is *finite* — every block you place is exactly one block of
water, wherever it ends up — while water connected to the sea or a lake (whose
surface sits at the world's water level) refills itself, like a real water
table.

## Creatures

Friendly **pigs, sheep and cows** wander the grass near you (ambient — they
don't fight or despawn your builds), and **wolves, spiders and squid** add a
little night-time danger. **Villagers** wander their village; give one a poke
and they'll say something.

- The owner's 🕊️ **Peaceful** toggle (world menu or pause screen) turns
  hostile danger off instantly, for everyone at once.
- Survive a real night and dawn counts it for you ("🌅 Night 12 survived!").
- **Everyone sees the same creatures** — the server runs their brains, so a
  wolf chasing your brother is the same wolf on both screens. Tabs can be
  hidden, anyone can leave, and the world keeps living.
- Creatures hatched from **spawn eggs** *persist*: fill a room with wolves,
  leave, come back — or have a friend join later — and the wolves are still
  there. They're saved with the world and included in snapshots/rewind, and
  they never wander-despawn like wild animals do.
- Hostiles hunt whichever player is nearest — a closed [door](#doors) keeps
  them out.

## The minimap

A round **minimap** sits in the top-right corner — you're the white arrow at
the centre, the orange ring is the village, and friends show as coloured dots.
It rotates with you, so up is always the way you're facing. Tap it (or press
`N`) to cycle big → small → hidden.

## Rewind (snapshots)

While a world is played the server quietly captures **snapshots** of its
state. The owner can open **⏱ Snapshots** (from the world row or the in-game
pause screen) to see a timeline and **rewind** the world to an earlier point —
handy for undoing a session of changes.

Rewinding takes a safety snapshot of the current state first (so it's itself
undoable) and sends everyone in that world back to the menu while the state is
restored. Snapshots roll over automatically: everything from the last day is
kept, then thinned to one an hour for a week, then dropped.

## Sound & music

Music and sound effects are **synthesized in the browser** (WebAudio), so the
game has sound with no files and works offline. A calm generative tune plays
in the background — it drops lower and quieter after dark — plus break / place
/ footstep effects and a living ambience (wind, birdsong by day, crickets at
night).

The 🔊 button (or `M`) mutes **everything** — music, effects, growls — except
voice chat, and remembers the choice across reloads.

Want real recorded audio instead? See
[Architecture → Custom audio](ARCHITECTURE.md#custom-audio).

## Voice chat

Click the **🎙️ button** (top-right) to join voice, then **hold `T`** (or hold
the on-screen **🗣️ Talk** button) to speak — push-to-talk, so no hot mic.
Voices get louder as players get closer and fade with distance. Whoever's
talking is highlighted green in the who's-online list and shows a speech
bubble above their character. Click 🎙️ again to leave voice.

Voice needs the game served over HTTPS, which is on by default — see
[Hosting → HTTPS](HOSTING.md#https--certificates).
