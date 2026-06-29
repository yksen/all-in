import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import type { Services } from "../services.ts";

export type AnySlashBuilder =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

/** A slash command. All interactions are guild-only ("cached"). */
export interface Command {
  data: AnySlashBuilder;
  /** Owner-only commands are hidden from non-owners and refused at dispatch. */
  ownerOnly?: boolean;
  execute(interaction: ChatInputCommandInteraction<"cached">, services: Services): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction<"cached">, services: Services): Promise<void>;
}

export type AnyComponentInteraction =
  | ButtonInteraction<"cached">
  | StringSelectMenuInteraction<"cached">
  | ModalSubmitInteraction<"cached">;

/**
 * Handles button/select/modal interactions whose customId begins with `prefix:`.
 * The first colon-separated segment of the customId selects the handler.
 */
export interface ComponentHandler {
  prefix: string;
  handle(interaction: AnyComponentInteraction, services: Services): Promise<void>;
}
