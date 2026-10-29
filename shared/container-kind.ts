import { markerKindInHeader } from "./issue-marker.ts";

export type ContainerKind = "map" | "spec" | null;

/** DSH-compatible container identity: spec marker wins, then the map label. */
export function containerKindOf(input: { type?: string | null; labels?: readonly { name?: string }[] | readonly string[]; body?: string | null; isMap?: boolean }): ContainerKind {
  if (markerKindInHeader(input.body ?? "") === "spec" || input.type === "spec") return "spec";
  const labels = input.labels ?? [];
  if (input.type === "map" || input.isMap || labels.some((label) => (typeof label === "string" ? label : label.name) === "wayfinder:map")) return "map";
  return null;
}
