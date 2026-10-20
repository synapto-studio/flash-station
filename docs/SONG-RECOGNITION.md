# Song recognition (roadmap R1)

**Answer: go.** In simulation, a **Pulse** drive can recognise a marked moment in a song from what its own mic hears. With 4 bars of listening (5.5 s at 174 BPM) it found both moments in all 13 test conditions, always within 60 ms of the moment. It never fired on the other song, the demo track, a crowd or a quiet room. This is **simulation only, with 2 songs**: see [What this doesn't prove yet](#what-this-doesnt-prove-yet).

Core drives aren't part of this: song moments are Pulse only.

## The clips (20 Oct 2026)
| Clip | Moment | What happens there | Tempo |
|---|---|---|---|
| SOTA – Poison | 1:28 | The bass drops out for 2 s (from 1:25.8), then the beat slams back in | 174 BPM |
| touchdown | 1:06 | A big hit, then a 2.5 s break with no bass (the beat returns at 1:09) | 174 BPM |

Both are 174 BPM drum & bass. That's the hardest case: the tempo can't tell them apart. The clips are not in either repo.

## How the drive recognises a moment
1. **Frames.** Every 78 ms (about a 16th note at 174 BPM) the drive notes 5 yes/no answers. Its beat detector already measures what they need. The answers are: did the kick get louder? Did the snare? Did everything? Did the balance tip towards the kick? Is everything louder than 2 frames ago?
2. **Print.** A print is those answers for the bars before the moment ("Listen for" in R4). The app makes it from the clip. It plays the clip through the drive model 16 times: in 4 rooms, each time plain, with reverb, with a crowd, and with another track under it. It keeps only the answers that came out the same at least 14 times. The rest are "don't care".
3. **Matching.** The drive remembers the last 10 s of answers. Every frame it compares them with each print at 5 speeds (a DJ's pitch: −2 %, −1 %, 0, +1 %, +2 %). It fires when two things are both true:
   - at most 16 % of the kept answers differ;
   - at most 25 % differ in each quarter of the print.

   Firing means "the moment is now".

The **score** in the tables is the share of kept answers that differed. 0 means identical, unrelated music scores about 0.4–0.5, and the limit is 0.16.

Code:
- `js/songs.js`: frames, prints, training and the drive's matcher.
- `test/songs.test.mjs`: tests on synthetic tracks.
- `test/song_experiment.mjs`: the run on real clips.
- Firmware repo `pulsetest/songmatch/`: the same matcher in C, measured on the ATtiny1614. It fires on exactly the same blocks as the JS: 163 fires on these clips, 139 on synthetic tracks.

## Results
### How much listening it needs
| Listen for | Poison: found at the right place | touchdown: found | Fired on the wrong song, demo or noise | Closest wrong score | Print size |
|---|---|---|---|---|---|
| 1 bar (1.4 s) | 12 of 13 | 10 of 13 | 31 times (24 on the other song, 6 on the demo, 1 on a crowd) | 0.11 | 30 bytes |
| 2 bars (2.7 s) | 11 of 13 | 11 of 13 | never | 0.17 | 51 bytes |
| 3 bars (4.1 s) | 12 of 13 | 12 of 13 | never | 0.21 | 74 bytes |
| **4 bars (5.5 s)** | **13 of 13** | **13 of 13** | **never** | **0.21** | **96 bytes** |
| 6 bars (8.3 s) | 11 of 13 | 13 of 13 | never | 0.19 | 140 bytes |

**Bars needed: 4 for both songs.** That's the shortest length that found the moment in every condition and never fired on anything else. Shorter misses the hard cases; 1 bar fires everywhere. 6 bars gets fussy about DJ pitch, because the oldest part of a long window drifts the most.

### Each condition, 4 bars
"Fired" is the time from the moment to the fire (− = early). "Right place" means within 1 beat (345 ms).

| Condition (none used in training) | Poison 1:28: fired | score | touchdown 1:06: fired | score |
|---|---|---|---|---|
| Club, new mic noise | +2 ms | 0.00 | +6 ms | 0.00 |
| Home (80 dB, less bass) | +2 ms | 0.01 | +6 ms | 0.00 |
| Bar (88 dB) | +2 ms | 0.01 | +6 ms | 0.01 |
| Big rig (104 dB) | +2 ms | 0.01 | +6 ms | 0.00 |
| Crowd 10 dB under the music | +2 ms | 0.03 | +6 ms | 0.01 |
| Crowd 3 dB under the music (cheers, hiss) | +2 ms | 0.11 | +6 ms | 0.12 |
| Club reverb, 1.2 s | +2 ms | 0.04 | +6 ms | 0.04 |
| DJ pitch +1 % | +15 ms | 0.04 | +35 ms | 0.02 |
| DJ pitch −1 % | −29 ms | 0.02 | −37 ms | 0.02 |
| DJ pitch +2 % | +11 ms | 0.04 | +52 ms | 0.13 |
| DJ pitch −2 % | 0 ms | 0.01 | −15 ms | 0.04 |
| Plugged in 2.6 s early, track 0.14 s later | +21 ms | 0.01 | +25 ms | 0.02 |
| DJ mix: the other song 6 dB under it | +2 ms | 0.15 | +6 ms | 0.06 |

Never fired on any of these:
- the other song, in all 13 conditions;
- the demo track (174 BPM), in a club and on a big rig;
- a crowd with no music, in a bar and in a club;
- a quiet room.

The closest any of them came was 0.21.

**Same song, other places:** Poison also fires at **3:29**, in 13 of 13 conditions. Its second drop is the same music, so the sound alone can't tell the two apart. touchdown fires nowhere else.

## What we learned
| Finding | What it means for R4/R5 |
|---|---|
| 4 bars is the sweet spot | R4: default Listen for = 4 bars, minimum 3. Play at = the end of listening or later, never earlier |
| Repeated sections match too (Poison 3:29) | R4: after saving, scan the whole clip with the new print. Show "also plays at 3:29" and let you choose "every time" or "first time only" |
| A DJ mix is the hardest case | Poison's moment is built on a 2 s gap, and a track 6 dB under it fills the gap (score 0.15, limit 0.16). Training with a track mixed in (added in this task) is what made it pass. A double drop (two tracks at full volume) probably won't be recognised |
| Loops can match elsewhere | A moment whose bars are mostly a loop the track repeats (or a drum break other tracks share) can match the loop. The "each quarter" rule stops a loop carrying a quarter that doesn't fit. The R4 scan above catches the rest |
| Too little to learn | 1 bar keeps ~35 answers and fires on other music. `MIN_KEPT` = 60: R4 should refuse a print below that ("pick a busier moment or listen longer") |
| DJ pitch up to ±2 % is fine | 5 speeds cover it. Beyond ±2 % isn't covered (rare in drum & bass) |
| Sample rate | Train at 16 kHz, as this experiment did. It's quick: the drive model's cost doesn't grow with the sample rate |

## Size on the ATtiny1614 (Pulse)
| | |
|---|---|
| Matcher code | **1,102 bytes** of flash (C, avr-gcc 14.1 `-Os`, measured) |
| Each song moment | **96 bytes** for 4 bars at 174 BPM (7 bytes + 10 bits a frame), in flash |
| RAM | **182 bytes** for up to 8 songs: the last 128 frames plus sums and state. Today's engine uses 334 of 2,048 bytes, so there's room |
| Chip time | Average ~0.7 ms per song per frame, about 1 % of the chip per song. Up to ~3.4 ms when a song nearly matches. R5 should check one or two songs per 13 ms block so the lights never stutter |

Flash is the tight part. Today's Pulse routine leaves 56 bytes, so the matcher plus 4 moments (~1.5 KB) must come from R5's player replacing the hand-written animations. The prints don't fit the 64-byte settings page; R5 gives them their own space.

## What this doesn't prove yet
- **Simulated only.** It uses the preview's mic and room model, the drive's real detector maths, and simple models of crowd, reverb and a DJ mix. Real speakers, a real room and the drive's real mic can only be checked on the bench. The first R5 step should be a bench test: play Poison from a speaker at a Pulse that flashes white when it recognises 1:28.
- **Only 2 songs.** Both are 174 BPM drum & bass. "Never fired on the wrong song" comes from 2 songs, a synthetic demo, a crowd and silence. With more songs, wrong matches get more likely. Before R4 is trusted, rerun this with 4–6 more clips, including a different genre and a track with a famous shared drum break.

## Rerunning it
```
node test/song_experiment.mjs "Poison.mp3@1:28" "touchdown.mp3@1:06" > results.md
```
It needs Node 22 and ffmpeg. Each clip is `file@moment`, plus `@bpm` if the track isn't 174 BPM. `--bars 2,4` tries other lengths. It takes about 1 minute for 2 full songs. The clips are read where they are and never copied into the repo.
