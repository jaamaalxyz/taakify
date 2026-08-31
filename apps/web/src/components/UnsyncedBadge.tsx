import { Badge } from "./ui/badge.js";

// Shared by BookCard, LoanRow, and BookDetail (issue #16) so the "Unsynced"
// affordance's wording/styling can't drift between the three places it
// renders.
export function UnsyncedBadge({ subject }: { subject: string }) {
  return (
    <Badge variant="destructive" title={`A local change to this ${subject} never reached the server`}>
      Unsynced
    </Badge>
  );
}
