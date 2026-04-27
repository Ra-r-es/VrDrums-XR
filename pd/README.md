# Pure Data Patch — hybrid sample player

Vanilla-Pd patch that receives OSC drum hits from the bridge server
and plays back real drum recordings. Vanilla only — no externals.

## Files

```
pd/
├── drumset.pd        main patch (OSC input, voices, loader, master)
├── voice-multi.pd    abstraction: 3-layer velocity-crossfade player
├── voice-single.pd   abstraction: single-sample velocity-scaled player
├── samples/          14 WAV files used by the patch
└── README.md         this file
```

## Sample set

| Voice      | Engine         | Source files in `samples/`                          |
|------------|----------------|------------------------------------------------------|
| bass drum  | 3-layer multi  | `bassdrum-{soft,med,hard}.wav`                       |
| snare      | 3-layer multi  | `snare-{soft,med,hard}.wav`                          |
| hi-hat     | 3-layer multi  | `hihat-{soft,med,hard}.wav`                          |
| hi-tom     | single-sample  | `hitom.wav`                                          |
| mid-tom    | single-sample  | `medtom.wav`                                         |
| floor tom  | single-sample  | `floortom.wav`                                       |
| crash      | single-sample  | `crash.wav`                                          |
| ride       | single-sample  | `ride.wav`                                           |

Multisampled drums come from MPC-Tutor's *8 Layer Drum Kit Tutorial*
kit (layers 031, 079, 127 from the 8-layer set, mapped to
soft/med/hard). Single-sample drums are from 99Sounds'
*99 Drum Samples I* (one acoustic hit per drum).

## Running

1. Install Pure Data vanilla 0.50 or newer. No externals needed.
2. Open `pd/drumset.pd` in Pd.
3. `Media → Audio On` (Ctrl-/). The DSP indicator must be lit.
4. The patch auto-loads all 14 samples on open; you should see each
   `read` succeed in the Pd console. Total load is a few seconds.
5. Start the rest of the project (`npm start` at the repo root).
   Every controller hit will now play through Pd.

The browser's own Web Audio engine keeps playing in parallel --- mute
the headset if you only want Pd's output.

## Signal flow

```
UDP :8000
    │
[netreceive -u -b 8000] -> [oscparse] -> [route /drum/hit]
                                               │
                                     [unpack s f f f f]
                                        │    │   │  │  │
                                        │    │   ▼  ▼  ▼
                                        │    │ [s hit-x/y/z]
                                        │    │
                                        └─ [pack s f]
                                               │
                                [route bassdrum snare … ride]
                                               │  (8 outlets)
                                               ▼
                                   [s fire-<name>]   × 8
                                               │
                        ┌──────────────────────┴──────────────────────┐
                        │                                              │
           [voice-multi <name>]             [voice-single <name>]
                        │                                              │
                        ▼                                              ▼
                [throw~ mix-L/R]                               [throw~ mix-L/R]
                                       │
                                [catch~ mix-L]   [catch~ mix-R]
                                       │               │
                                    [*~ 0.8]        [*~ 0.8]
                                       │               │
                                    [clip~]          [clip~]
                                       │               │
                                        [dac~ 1 2]
```

## How velocity crossfade works

Each multisample voice receives a velocity $v \in [0, 1]$ and plays
all three layers simultaneously, gated by three weights that sum
to 1:

```
 soft_gain = max(0, 1 - 2v)          peaks at v=0
 med_gain  = min(2v, 2(1-v))         peaks at v=0.5
 hard_gain = max(0, 2v - 1)          peaks at v=1
```

- `v = 0.25`: 50% soft + 50% med + 0% hard
- `v = 0.50`: 100% med
- `v = 0.75`: 0% soft + 50% med + 50% hard

The three `[tabplay~]` players are triggered simultaneously; each
output is scaled by its weight, then the three are summed. The sonic
result is that the attack timbre smoothly morphs between the three
recordings as the user hits harder, instead of simply getting louder.

Single-sample voices skip the crossfade --- velocity goes straight to
a scalar multiplier on the `[tabplay~]` output.

## Swapping samples

To swap a sample, just overwrite the file in `pd/samples/` with the
same name. Re-open the patch (or click the big message box manually)
and the `[soundfiler]` chain reloads everything.

To point the patch at a different *set* of samples, edit the mega-
message box at the top of the loader section; each `read -resize`
entry pairs a file path with an array name.

## Troubleshooting

- **No sound, but Pd console shows load errors**: the `read` command
  couldn't find a WAV. Confirm the file names in `pd/samples/` match
  those in the loader message box exactly. Pd is case-sensitive.
- **Sound is quiet / clipping**: raise or lower the master `*~ 0.8`
  at the bottom of the patch.
- **No reaction to hits but bridge logs them**: the patch binds UDP
  port 8000. If Pd reports `bind: Address already in use`, another
  Pd instance is already holding the port --- close it and reopen.
- **`tabplay~ ... no such array` console warnings on open**: the
  patch declares arrays via `[table name 100]` then resizes them via
  `[soundfiler]`. If `soundfiler` fails to load a file, its array
  stays at size 100 and plays silence. Fix by correcting the file
  path and reopening.
