/** Await a delay — used to pace ASCII animation frames between message edits. */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
