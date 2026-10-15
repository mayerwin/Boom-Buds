# Roadmap

Ideas for after the first version, roughly in order of value.

## Network play

* **Play with anyone: matchmaking by ping.** A public lobby on the relays where open games announce
  themselves with their region and player count; joining players measure the round trip to each host
  (a short WebRTC probe, or the relay's timestamps as a first estimate) and are offered the closest games
  first. Rooms could carry a "public" flag set by the host, with the room code still working for private
  games.
* **TURN relay out of the box.** Direct connections fail between two strict NATs (some mobile carriers).
  A free Cloudflare TURN account with a tiny serverless function handing out short-lived credentials (or a
  Metered free plan) would make every pair of players connect. The client already accepts a TURN server
  at build time.
* **Joining a match in progress** as a spectator, and taking over a computer player at the next round.
* **Host migration**: today the room closes when its host leaves.
* **Chat and emotes** in the lobby.

## Local play

* **Four players on a tablet.** Tablets track ten or more touches, so it is technically possible, but on a
  4:3 iPad the controls would cover the arena's corners and hands would hide the picture. A layout with one
  small control cluster per corner, each rotated toward its player, plus a slightly smaller arena, is worth
  a prototype on a 16:10 tablet.
* **Custom gamepad mappings** in the Controls screen (today: the standard mapping, which modern gamepads use).
* **Player names and colours** chosen in the setup.

## Computer players

* Use the Blue Hand (grab and throw) and the Spooge deliberately.
* Planned two-step attacks: kick a bomb and stop it with Special on a chosen cell, punches aimed to land on
  a head, trigger bombs laid along an opponent's predicted path.
* Fewer self-inflicted deaths for skill 5 in chain reactions with sliding bombs (kicked or on conveyors): a
  finer timing model of sliding bombs, or a one-step margin in those chains.
* Against weak opponents, refuse attacks with a thin escape margin (a mutual kill is only a draw).
* A small trap search for skill 3, so that two skill-3 bots finish each other more often instead of reaching
  the time limit; and a way to dig out players camping on a few arenas (trampolines, level 7 and 9 layouts).
* A "personality" knob (cautious / aggressive) independent of the skill level.

## Presentation

* A live demo round behind the main menu instead of the still picture.
* Remappable in-round shortcuts, subtitles for the announcer voices.
* Optional CRT-style filter.

## Original content

* The campaign mode and the level editor still use the original menus; they could get modern screens too.
