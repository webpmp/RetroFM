# RetroFM player (boom box UI)

Self-contained front end for RetroFM. Open `index.html` to run it. No build step, no dependencies.

```
player/
  index.html        markup
  player.css        styles
  player.js         all behavior (no inline scripts, Manifest V3 friendly)
  images/           boom-box-white.png, boom-box-black.png (1408x768, dial/needles already cleaned)
  logos/            1960s-white.png, 1960s-black.png ... 2020s-white.png, 2020s-black.png
```
Use lowercase names everywhere (paths are case sensitive in extensions and on servers).

## What the user does
1. Types a date (month name, Jan/Sept style abbreviations, misspellings like "Marrch", or 7/4/1978). Valid range: 1960 to today. Enter or Tab moves to the genre step.
2. Picks a genre (up/down arrows or click the genre row). The genre list depends on the decade of the date. Enter tunes in.
3. The green display then shows `[DATE] [GENRE]` (click either to edit), the FM frequency, and the song (title and artist fade in turn; the small dot turns that off).
4. Play / Pause / Stop on the cassette deck, Volume and Balance dials, tuning dial (hops to other genre stations of the same decade). Clicking the logo toggles light/dark.

## Events the player sends (on `document`, data in `event.detail`)
| event | detail | meaning |
|---|---|---|
| `retrofm:select` | `{date:'1978-07-04', year, decade, genre, frequency}` | user pressed Enter on the genre step. Find a song released BEFORE this date |
| `retrofm:tune` | `{decade, frequency, genre\|null, locked}` | dial moved onto a station (or between stations, genre null) |
| `retrofm:update` | `{}` | user went back to edit the date or genre |
| `retrofm:transport` | `{state:'playing'\|'paused'\|'stopped'}` | user pressed a transport button |
| `retrofm:volume` | `{value: 0..1}` | volume dial |
| `retrofm:balance` | `{value: -1..1}` | balance dial (-1 = full left) |
| `retrofm:theme` | `{dark: bool}` | logo toggled light/dark |
| `retrofm:previous` | `{}` | user clicked REWIND (symbol flashes). Not wired to anything yet |
| `retrofm:next` | `{}` | user clicked FAST FORWARD (symbol flashes). Not wired to anything yet |
| `retrofm:record` | `{on: bool}` | user clicked RECORD (latches on/off). Planned: request a song by typing its name |
| `retrofm:display` | `{open: bool}` | green display expanded/collapsed |

## Calls into the player
- `RetroFM.setSong({title, artist})` shows the song on the display. Call it once the YouTube song is chosen.
- `RetroFM.setSongYear(year)` switches the logo to that song's decade.
- `RetroFM.setTransport('playing'|'paused'|'stopped')` updates buttons, lit symbols, reels and meters WITHOUT sending a `retrofm:transport` event (use when YouTube state changes by itself, e.g. a song ends).
- Alternative: dispatch `retrofm:song` with `{title, artist, year}`.

## Settings at the top of `player.js` sections
- `BUTTONS = {rewind, forward, record}` in `player.js`: set any to `false` to disable that button entirely (no click area, no event).
- `DEMO = true` shows a placeholder song about a second after tuning in. Set `false` when real songs are wired up.
- `LOGO_BASE = 'logos/'`, `BOX_BASE = 'images/'`.
- `ST` holds the genres and FM frequency per decade (1960s-2020s). Edit there.

## Notes for the extension
- The VU meters are simulated (the audio plays in YouTube, so there is nothing to analyze). They react to play/pause, Volume and Balance.
- The window is designed at 450px wide and scales to fit the width and height of whatever window it is in, with no scrolling.
- A normal browser-action popup closes when it loses focus. For a small window that stays open while working, open it with `chrome.windows.create({url:'player/index.html', type:'popup', width:450, height:520})` or use the side panel.
- Wiring: on `retrofm:select` pick a song, play it on YouTube, then call `RetroFM.setSong(...)`. Map `retrofm:volume` / `retrofm:balance` / `retrofm:transport` to the existing VolumeController and YouTube controls.
