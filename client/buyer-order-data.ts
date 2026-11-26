import type { Line } from "./types";

export const activeLine = (line: Line) =>
  ["RESERVED", "RELEASE_PENDING"].includes(line.outcome);
