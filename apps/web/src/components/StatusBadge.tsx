import { Badge } from "./ui/badge.js";
import { READING_STATUS_LABELS, type ReadingStatus } from "../lib/labels.js";

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
  return <Badge variant={STATUS_VARIANTS[status]}>{READING_STATUS_LABELS[status]}</Badge>;
}
