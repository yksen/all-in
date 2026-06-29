import type { Client } from "discord.js";
import type { Database } from "bun:sqlite";
import { config, type Config } from "./config.ts";
import { logger, type Logger } from "./lib/logger.ts";
import { Wallet } from "./economy/wallet.ts";
import { Rounds } from "./economy/rounds.ts";
import { KeyedMutex } from "./economy/locks.ts";

/** Shared dependencies handed to every command and component handler. */
export interface Services {
  config: Config;
  logger: Logger;
  db: Database;
  wallet: Wallet;
  rounds: Rounds;
  locks: KeyedMutex;
  client: Client;
}

export function buildServices(db: Database, client: Client): Services {
  return {
    config,
    logger,
    db,
    wallet: new Wallet(db),
    rounds: new Rounds(db),
    locks: new KeyedMutex(),
    client,
  };
}
