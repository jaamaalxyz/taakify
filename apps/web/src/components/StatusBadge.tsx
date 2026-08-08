import { Badge } from "./ui/badge.js";

export type ReadingStatus = "unread" | "want_to_read" | "reading" | "finished" | "abandoned";

const STATUS_LABELS: Record<ReadingStatus, string> = {
  unread: "Unread",
  want_to_read: "Want to Read",
  reading: "Reading",
  finished: "Finished",
  abandoned: "Abandoned",
};

// Variant mapping: "reading" is the active/in-progress state, so it gets the
// primary (default) variant to stand out. "finished" is a completed, neutral
// state -> secondary. "unread"/"want_to_read" are passive/not-yet-started
// states -> outline. "abandoned" is a negative/inactive state -> destructive.
const STATUS_VARIANTS: Record<ReadingStatus, "default" | "secondary" | "outline" | "destructive"> = {
  unread: "outline",
  want_to_read: "outline",
  reading: "default",
  finished: "secondary",
  abandoned: "destructive",
};

export function StatusBadge({ status }: { status?: ReadingStatus | null }) {
  if (!status) return null;
  return <Badge variant={STATUS_VARIANTS[status]}>{STATUS_LABELS[status]}</Badge>;
}
