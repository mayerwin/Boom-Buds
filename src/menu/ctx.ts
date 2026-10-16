// What every menu screen can reach: the game, the menu shell and a few helpers.

import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { Game } from '../app/Game.ts';
import type { MenuArt } from './art.ts';
import type { NetSession } from '../net/netSession.ts';
import type { MatchParams } from '../screens/match.ts';
import type { JoinHook } from './nav.ts';

export type ScreenId = 'home' | 'local' | 'network' | 'lobby' | 'controls' | 'options' | 'howto';

/** How the menus hand over to the game. */
export type MenuExit =
  | { kind: 'local' }
  | { kind: 'net-match'; params: MatchParams }
  | { kind: 'classic' }
  | { kind: 'editor' }
  | { kind: 'campaign' };

export interface MenuContext {
  g: Game;
  art: MenuArt;
  go(screen: ScreenId): void;
  back(): void;
  exit(e: MenuExit): void;
  toast(text: string, bad?: boolean): void;
  /** play a menu sound: 'move' | 'ok' | 'no' */
  sound(kind: 'move' | 'ok' | 'no'): void;
  /** the network session of the current room (null outside network games) */
  net: NetSession | null;
  setNet(n: NetSession | null): void;
  save(): void;
  /** a line-up is open: holding a gamepad's button adds a player (null: closed) */
  setJoinHook(h: JoinHook | null): void;
}

export const Ctx = createContext<MenuContext>(null as unknown as MenuContext);
export const useMenu = (): MenuContext => useContext(Ctx);

/** Player colours of the ten slots (the HUD order). */
export const PLAYER_COLOURS = ['#f2f2f2', '#3a3a3a', '#ff3b3b', '#3b6bff', '#2fd36b', '#ffd83b', '#3bf0ff', '#ff4fe1', '#ff9a2f', '#9a5bff'];
