import { Badge } from "./ui/badge.js";

// Shared by BookCard, LoanRow, and BookDetail (issue #16) so the "Unsynced"
// affordance's wording/styling can't drift between the three places it
// renders. `subject` is a closed union, not a free string: it feeds the
// title tooltip's template, so a typo would ship straight to users.
export function UnsyncedBadge({ subject }: { subject: "book" | "loan" }) {
  return (
    <Badge variant="destructive" title={`A local change to this ${subject} never reached the server`}>
      Unsynced
    </Badge>
  );
}
