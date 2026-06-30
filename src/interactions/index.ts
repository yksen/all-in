import type { ComponentHandler } from "../framework/types.ts";
import { blackjackComponent } from "../games/blackjack.ts";
import { rouletteComponent } from "../games/roulette.ts";
import { crashComponent } from "../games/crash.ts";
import { crapsComponent } from "../games/craps.ts";
import { pokerComponent } from "../games/poker.ts";
import { coinflipComponent } from "../games/coinflip.ts";
import { diceDuelComponent } from "../games/diceduel.ts";

/**
 * Component handlers, keyed by the first segment of a button/select/modal customId.
 * Games register their handler here. Static list for the compiled binary.
 */
export const componentHandlers: ComponentHandler[] = [
  blackjackComponent,
  rouletteComponent,
  crashComponent,
  crapsComponent,
  pokerComponent,
  coinflipComponent,
  diceDuelComponent,
];
