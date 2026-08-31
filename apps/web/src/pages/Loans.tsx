import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { BookOpen, HandCoins } from "lucide-react";
import { toast } from "sonner";
import { useHousehold } from "../lib/household-context.js";
import { listLoans, createLoan, updateLoan } from "../lib/repo/loans.js";
import { listContacts, createContact, updateContact } from "../lib/repo/contacts.js";
import { listBooks } from "../lib/repo/books.js";
import { onMirrorChange } from "../lib/sync/shape.js";
import { friendlyError } from "../lib/error-messages.js";
import { todayStr } from "../lib/local-date.js";
import { LOAN_DIRECTION_LABELS, type LoanDirection as Direction } from "../lib/labels.js";
import type { Loan as SharedLoan, Contact as SharedContact } from "@taakify/shared";
import { Skeleton } from "../components/ui/skeleton.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Label } from "../components/ui/label.js";
import { Input } from "../components/ui/input.js";
import { Card, CardContent } from "../components/ui/card.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";

type Loan = SharedLoan;
type Contact = SharedContact;

type SimpleBook = { id: string; edition: { title: string; authors: string } };

const NEW_CONTACT = "__new__";

function LoanRow({
  loan,
  showReturnAction,
  onMarkReturned,
  returning,
}: {
  loan: Loan;
  showReturnAction: boolean;
  onMarkReturned?: (id: string) => void;
  returning?: boolean;
}) {
  return (
    <li className="flex items-center gap-3 rounded-lg border p-3">
      <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
        {loan.book.edition.cover_url ? (
          <img src={loan.book.edition.cover_url} alt="" className="h-full w-full object-cover" />
        ) : (
          <BookOpen className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <Link to={`/library/${loan.book.id}`} className="text-sm font-medium hover:underline">
          {loan.book.edition.title}
        </Link>
        <p className="text-xs text-muted-foreground">
          {LOAN_DIRECTION_LABELS[loan.direction]} · {loan.contact.name}
          {loan.due_date && ` · due ${loan.due_date}`}
        </p>
        {loan.overdue && <Badge variant="destructive">Overdue</Badge>}
      </div>
      {showReturnAction && (
        <Button size="sm" variant="outline" onClick={() => onMarkReturned?.(loan.id)} disabled={returning}>
          {returning ? "Saving…" : "Mark returned"}
        </Button>
      )}
    </li>
  );
}

export function Loans() {
  const { household, user } = useHousehold();

  const [loans, setLoans] = useState<Loan[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [returningId, setReturningId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [books, setBooks] = useState<SimpleBook[]>([]);
  // Surfaced inline in the "Add loan" dialog (not a blocking Alert) — a
  // failure here just means the book/contact pickers render empty, which
  // is otherwise unexplained to the user.
  const [contactsLoadError, setContactsLoadError] = useState("");
  const [booksLoadError, setBooksLoadError] = useState("");

  // Contacts dialog — doubles as create and edit, matching the brief's
  // "create/edit contact" requirement with one reused form: editingContactId
  // is null for "new contact" and set to an existing contact's id when the
  // user picks one from the list below the form to edit it.
  const [contactOpen, setContactOpen] = useState(false);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [savingContact, setSavingContact] = useState(false);
  const [contactError, setContactError] = useState("");

  // Lend out dialog
  const [lendOpen, setLendOpen] = useState(false);
  const [lendBookId, setLendBookId] = useState("");
  const [lendContactSelection, setLendContactSelection] = useState<string>(NEW_CONTACT);
  const [lendNewContactName, setLendNewContactName] = useState("");
  const [lendDirection, setLendDirection] = useState<Direction>("lent_out");
  const [lendDueDate, setLendDueDate] = useState("");
  const [savingLoan, setSavingLoan] = useState(false);
  const [lendError, setLendError] = useState("");

  // Deliberate deviation from the GET /api/loans?active=true contract: we
  // fetch the full unfiltered loan list once and derive both the Active and
  // History sections from it client-side (see activeLoans/historyLoans
  // below), rather than issuing two separate requests (one with
  // active=true, one without). This keeps "mark returned" and "record a
  // loan" each need only one refetch to keep both sections in sync, at the
  // cost of fetching slightly more data up front than active=true alone
  // would. For a household's loan history size this is a non-issue.
  function loadLoans() {
    setLoadError("");
    listLoans({ householdId: household.id })
      .then((data) => setLoans(data))
      .catch((e) => setLoadError(friendlyError(e)));
  }

  function loadContacts() {
    setContactsLoadError("");
    listContacts(household.id)
      .then((data) => setContacts(data))
      .catch((e) => {
        setContacts([]);
        setContactsLoadError(friendlyError(e));
      });
  }

  function loadBooks() {
    setBooksLoadError("");
    listBooks({ householdId: household.id })
      .then((data) => setBooks(data))
      .catch((e) => {
        setBooks([]);
        setBooksLoadError(friendlyError(e));
      });
  }

  // Bumped whenever the local mirror changes underneath us (a remote edit
  // streaming in via Electric, or our own optimistic write) -- re-runs the
  // loaders below so e.g. another household member recording/returning a
  // loan shows up without a manual navigate-away-and-back (Important
  // finding, final whole-branch review).
  const [mirrorTick, setMirrorTick] = useState(0);
  useEffect(() => onMirrorChange(() => setMirrorTick((t) => t + 1)), []);

  useEffect(() => {
    loadLoans();
    loadContacts();
    loadBooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [household.id, mirrorTick]);

  async function handleMarkReturned(loanId: string) {
    setActionError("");
    setReturningId(loanId);
    try {
      await updateLoan(loanId, { returned_date: todayStr() });
      toast("Marked as returned");
      loadLoans();
    } catch (err) {
      setActionError(friendlyError(err));
    } finally {
      setReturningId(null);
    }
  }

  function resetContactForm() {
    setEditingContactId(null);
    setContactName("");
    setContactPhone("");
    setContactEmail("");
  }

  function startEditContact(contact: Contact) {
    setEditingContactId(contact.id);
    setContactName(contact.name);
    setContactPhone(contact.phone ?? "");
    setContactEmail(contact.email ?? "");
    setContactError("");
  }

  async function handleSaveContact(e: FormEvent) {
    e.preventDefault();
    if (!contactName.trim()) return;
    setContactError("");
    setSavingContact(true);
    try {
      const name = contactName.trim();
      const phone = contactPhone.trim() || null;
      const email = contactEmail.trim() || null;
      if (editingContactId) {
        await updateContact(editingContactId, { name, phone, email });
        setContacts((prev) => prev.map((c) => (c.id === editingContactId ? { ...c, name, phone, email } : c)));
        toast(`Updated contact "${name}"`);
      } else {
        const id = await createContact({
          householdId: household.id,
          name,
          phone: phone || undefined,
          email: email || undefined,
          createdBy: user.id,
        });
        setContacts((prev) => [...prev, { id, name, phone, email }]);
        toast(`Added contact "${name}"`);
      }
      resetContactForm();
      setContactOpen(false);
    } catch (err) {
      setContactError(friendlyError(err));
    } finally {
      setSavingContact(false);
    }
  }

  async function handleCreateLoan(e: FormEvent) {
    e.preventDefault();
    if (!lendBookId) {
      setLendError("Choose a book.");
      return;
    }
    if (lendContactSelection === NEW_CONTACT && !lendNewContactName.trim()) {
      setLendError("Choose a contact or enter a new contact name.");
      return;
    }
    setLendError("");
    setSavingLoan(true);
    try {
      await createLoan({
        bookId: lendBookId,
        direction: lendDirection,
        dueDate: lendDueDate || undefined,
        contactId: lendContactSelection === NEW_CONTACT ? undefined : lendContactSelection,
        contactName: lendContactSelection === NEW_CONTACT ? lendNewContactName.trim() : undefined,
        createdBy: user.id,
      });
      toast("Loan recorded");
      setLendOpen(false);
      setLendBookId("");
      setLendContactSelection(NEW_CONTACT);
      setLendNewContactName("");
      setLendDirection("lent_out");
      setLendDueDate("");
      loadLoans();
      loadContacts();
    } catch (err) {
      setLendError(friendlyError(err));
    } finally {
      setSavingLoan(false);
    }
  }

  const activeLoans = loans?.filter((l) => l.returned_date === null) ?? [];
  const historyLoans = loans?.filter((l) => l.returned_date !== null) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Loans</h1>
        <div className="flex gap-2">
          <Dialog
            open={contactOpen}
            onOpenChange={(open) => {
              setContactOpen(open);
              if (!open) {
                resetContactForm();
                setContactError("");
              }
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                Contacts
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Contacts</DialogTitle>
              </DialogHeader>

              {contacts.length > 0 && (
                <ul className="max-h-32 space-y-1 overflow-y-auto rounded-md border p-2">
                  {contacts.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => startEditContact(c)}
                        className="w-full rounded px-2 py-1 text-left text-sm hover:bg-accent"
                      >
                        {c.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <form onSubmit={handleSaveContact} className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground">
                    {editingContactId ? "Edit contact" : "New contact"}
                  </p>
                  {editingContactId && (
                    <button
                      type="button"
                      onClick={resetContactForm}
                      className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                    >
                      + New contact instead
                    </button>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="contact-name">Name</Label>
                  <Input
                    id="contact-name"
                    value={contactName}
                    onChange={(e) => setContactName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="contact-phone">Phone</Label>
                  <Input id="contact-phone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="contact-email">Email</Label>
                  <Input id="contact-email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
                </div>
                {contactError && (
                  <Alert variant="destructive">
                    <AlertDescription>{contactError}</AlertDescription>
                  </Alert>
                )}
                <DialogFooter>
                  <Button type="submit" disabled={savingContact}>
                    {savingContact ? "Saving…" : editingContactId ? "Save changes" : "Add contact"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog open={lendOpen} onOpenChange={setLendOpen}>
            <DialogTrigger asChild>
              <Button size="sm">Add loan</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Record a loan</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreateLoan} className="space-y-3">
                {(booksLoadError || contactsLoadError) && (
                  <p className="text-xs text-muted-foreground">
                    {booksLoadError && contactsLoadError
                      ? "Couldn't load books or contacts, so those pickers may be empty — try reopening this dialog."
                      : booksLoadError
                        ? "Couldn't load books, so the book picker may be empty — try reopening this dialog."
                        : "Couldn't load contacts, so the contact picker may be empty — try reopening this dialog."}
                  </p>
                )}
                <div className="space-y-1">
                  <Label htmlFor="lend-book">Book</Label>
                  <Select value={lendBookId} onValueChange={setLendBookId}>
                    <SelectTrigger id="lend-book" className="w-full">
                      <SelectValue placeholder="Choose a book" />
                    </SelectTrigger>
                    <SelectContent>
                      {books.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.edition.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="lend-direction">Direction</Label>
                  <Select value={lendDirection} onValueChange={(v) => setLendDirection(v as Direction)}>
                    <SelectTrigger id="lend-direction" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="lent_out">Lent out</SelectItem>
                      <SelectItem value="borrowed_in">Borrowed in</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="lend-contact">Contact</Label>
                  <Select value={lendContactSelection} onValueChange={setLendContactSelection}>
                    <SelectTrigger id="lend-contact" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NEW_CONTACT}>+ New contact</SelectItem>
                      {contacts.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {lendContactSelection === NEW_CONTACT && (
                  <div className="space-y-1">
                    <Label htmlFor="lend-new-contact-name">New contact name</Label>
                    <Input
                      id="lend-new-contact-name"
                      value={lendNewContactName}
                      onChange={(e) => setLendNewContactName(e.target.value)}
                    />
                  </div>
                )}
                <div className="space-y-1">
                  <Label htmlFor="lend-due-date">Due date</Label>
                  <Input
                    id="lend-due-date"
                    type="date"
                    value={lendDueDate}
                    onChange={(e) => setLendDueDate(e.target.value)}
                  />
                </div>
                {lendError && (
                  <Alert variant="destructive">
                    <AlertDescription>{lendError}</AlertDescription>
                  </Alert>
                )}
                <DialogFooter>
                  <Button type="submit" disabled={savingLoan}>
                    {savingLoan ? "Saving…" : "Record loan"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>Couldn't load loans: {loadError}</AlertDescription>
        </Alert>
      )}

      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {!loadError && loans === null && (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {!loadError && loans !== null && (
        <>
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Active</h2>
            {activeLoans.length === 0 && (
              <Card>
                <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
                  <HandCoins className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
                  <p className="text-sm text-muted-foreground">No active loans.</p>
                </CardContent>
              </Card>
            )}
            {activeLoans.length > 0 && (
              <ul className="space-y-2">
                {activeLoans.map((loan) => (
                  <LoanRow
                    key={loan.id}
                    loan={loan}
                    showReturnAction
                    onMarkReturned={handleMarkReturned}
                    returning={returningId === loan.id}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">History</h2>
            {historyLoans.length === 0 && (
              <p className="text-sm text-muted-foreground">No returned loans yet.</p>
            )}
            {historyLoans.length > 0 && (
              <ul className="space-y-2">
                {historyLoans.map((loan) => (
                  <LoanRow key={loan.id} loan={loan} showReturnAction={false} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
