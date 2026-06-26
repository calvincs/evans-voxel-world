Drop real audio in here to replace the built-in synthesized sound.

The game looks for these filenames (any of .mp3, .ogg, .wav). If a file is
present it is used; if not, the game synthesizes that sound itself.

    music.mp3   - looping background music
    break.mp3   - playing when a block is broken
    place.mp3   - playing when a block is placed
    step.mp3    - footstep

So to add a breaking-bricks sound, save it as:  break.wav  (or .mp3/.ogg)

Where to get FREE, safe-to-use audio (CC0 / public domain - no attribution
required, safe to keep in the project even if you share the game):

    - https://kenney.nl/assets?q=audio        (CC0 game sound packs)
    - https://pixabay.com/sound-effects/       (free, no attribution)
    - https://pixabay.com/music/               (free background music)
    - https://freesound.org/  -> filter License: "Creative Commons 0"

Tips:
    - Keep music a small file (a 1-2 minute loop is plenty; it repeats).
    - Short SFX (under ~1s) feel best for break/place/step.
    - After adding files, just refresh the browser.
