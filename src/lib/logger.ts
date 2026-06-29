import pino from "pino";
import { config } from "../config.ts";

/**
 * Structured logger. In production (LOG_FORMAT=json) it writes plain JSON lines to
 * stdout, which systemd captures into the journal. For local dev, pino-pretty makes
 * it readable.
 */
export const logger = pino(
  config.log.format === "pretty"
    ? {
        level: config.log.level,
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : { level: config.log.level },
);

export type Logger = typeof logger;
