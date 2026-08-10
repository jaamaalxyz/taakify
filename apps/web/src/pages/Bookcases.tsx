import { useEffect, useState, type FormEvent } from "react";
import { Library as LibraryIcon, ArrowUp, ArrowDown } from "lucide-react";
import { toast } from "sonner";
import { useHousehold } from "../lib/household-context.js";
import { api } from "../lib/api.js";
import { friendlyError } from "../lib/error-messages.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Label } from "../components/ui/label.js";
import { Input } from "../components/ui/input.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";

type Shelf = { id: string; position: number; label: string; updated_at: string };
type Bookcase = { id: string; name: string; updated_at: string; shelves: Shelf[] };

export function Bookcases() {
  const { household } = useHousehold();

  const [bookcases, setBookcases] = useState<Bookcase[] | null>(null);
  const [loadError, setLoadError] = useState("");

  // Add-bookcase dialog
  const [addBookcaseOpen, setAddBookcaseOpen] = useState(false);
  const [newBookcaseName, setNewBookcaseName] = useState("");
  const [savingBookcase, setSavingBookcase] = useState(false);
  const [bookcaseError, setBookcaseError] = useState("");

  // Add-shelf dialog — tracks which bookcase it's open for.
  const [addShelfFor, setAddShelfFor] = useState<Bookcase | null>(null);
  const [newShelfLabel, setNewShelfLabel] = useState("");
  const [savingShelf, setSavingShelf] = useState(false);
  const [shelfError, setShelfError] = useState("");

  // Edit-shelf-label dialog.
  const [editShelf, setEditShelf] = useState<Shelf | null>(null);
  const [editShelfLabel, setEditShelfLabel] = useState("");
  const [savingEditShelf, setSavingEditShelf] = useState(false);
  const [editShelfError, setEditShelfError] = useState("");

  // Shelf reorder (up/down arrows) — tracks the shelf id currently being
  // swapped so its buttons (and its neighbor's) disable during the PATCHes.
  const [reorderingShelfId, setReorderingShelfId] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState("");

  function loadBookcases() {
    setLoadError("");
    api<{ bookcases: Bookcase[] }>(`/api/bookcases?householdId=${household.id}`)
      .then((data) => setBookcases(data.bookcases))
      .catch((e) => setLoadError(friendlyError(e)));
  }

  useEffect(() => {
    loadBookcases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [household.id]);

  async function handleAddBookcase(e: FormEvent) {
    e.preventDefault();
    if (!newBookcaseName.trim()) return;
    setBookcaseError("");
    setSavingBookcase(true);
    try {
      await api("/api/bookcases", {
        method: "POST",
        body: JSON.stringify({ householdId: household.id, name: newBookcaseName.trim() }),
      });
      toast(`Added bookcase "${newBookcaseName.trim()}"`);
      setNewBookcaseName("");
      setAddBookcaseOpen(false);
      loadBookcases();
    } catch (err) {
      setBookcaseError(friendlyError(err));
    } finally {
      setSavingBookcase(false);
    }
  }

  async function handleAddShelf(e: FormEvent) {
    e.preventDefault();
    if (!addShelfFor) return;
    setShelfError("");
    setSavingShelf(true);
    try {
      await api(`/api/bookcases/${addShelfFor.id}/shelves`, {
        method: "POST",
        body: JSON.stringify({ label: newShelfLabel.trim() || undefined }),
      });
      toast("Shelf added");
      setNewShelfLabel("");
      setAddShelfFor(null);
      loadBookcases();
    } catch (err) {
      setShelfError(friendlyError(err));
    } finally {
      setSavingShelf(false);
    }
  }

  async function handleEditShelf(e: FormEvent) {
    e.preventDefault();
    if (!editShelf) return;
    setEditShelfError("");
    setSavingEditShelf(true);
    try {
      await api(`/api/shelves/${editShelf.id}`, {
        method: "PATCH",
        body: JSON.stringify({ label: editShelfLabel.trim() }),
      });
      toast("Shelf updated");
      setEditShelf(null);
      loadBookcases();
    } catch (err) {
      setEditShelfError(friendlyError(err));
    } finally {
      setSavingEditShelf(false);
    }
  }

  async function handleSwapShelves(a: Shelf, b: Shelf) {
    setReorderError("");
    setReorderingShelfId(a.id);
    try {
      await Promise.all([
        api(`/api/shelves/${a.id}`, {
          method: "PATCH",
          body: JSON.stringify({ position: b.position }),
        }),
        api(`/api/shelves/${b.id}`, {
          method: "PATCH",
          body: JSON.stringify({ position: a.position }),
        }),
      ]);
      loadBookcases();
    } catch (err) {
      setReorderError(friendlyError(err));
    } finally {
      setReorderingShelfId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Bookcases</h1>
        <Dialog open={addBookcaseOpen} onOpenChange={setAddBookcaseOpen}>
          <DialogTrigger asChild>
            <Button size="sm">Add bookcase</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New bookcase</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleAddBookcase} className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="bookcase-name">Name</Label>
                <Input
                  id="bookcase-name"
                  value={newBookcaseName}
                  onChange={(e) => setNewBookcaseName(e.target.value)}
                  required
                />
              </div>
              {bookcaseError && (
                <Alert variant="destructive">
                  <AlertDescription>{bookcaseError}</AlertDescription>
                </Alert>
              )}
              <DialogFooter>
                <Button type="submit" disabled={savingBookcase}>
                  {savingBookcase ? "Saving…" : "Add"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>Couldn't load bookcases: {loadError}</AlertDescription>
        </Alert>
      )}

      {!loadError && bookcases === null && (
        <div className="space-y-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {!loadError && bookcases !== null && bookcases.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
            <LibraryIcon className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">No bookcases yet.</p>
          </CardContent>
        </Card>
      )}

      {!loadError && bookcases !== null && bookcases.length > 0 && (
        <div className="space-y-3">
          {bookcases.map((bc) => (
            <Card key={bc.id}>
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardTitle className="text-sm">{bc.name}</CardTitle>
                <Button size="sm" variant="outline" onClick={() => setAddShelfFor(bc)}>
                  Add shelf
                </Button>
              </CardHeader>
              <CardContent className="space-y-2">
                {bc.shelves.length === 0 && (
                  <p className="text-sm text-muted-foreground">No shelves yet.</p>
                )}
                {bc.shelves.length > 0 && (
                  <ul className="flex flex-wrap gap-2">
                    {bc.shelves.map((shelf, index) => {
                      const shelfAbove = index > 0 ? bc.shelves[index - 1] : null;
                      const shelfBelow = index < bc.shelves.length - 1 ? bc.shelves[index + 1] : null;
                      const swapping = reorderingShelfId !== null;
                      return (
                        <li key={shelf.id} className="flex items-center gap-1">
                          <Badge
                            variant="outline"
                            role="button"
                            tabIndex={0}
                            className="cursor-pointer gap-1"
                            onClick={() => {
                              setEditShelf(shelf);
                              setEditShelfLabel(shelf.label ?? "");
                            }}
                          >
                            {shelf.label || `Shelf ${shelf.position}`}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            aria-label={`Move ${shelf.label || `Shelf ${shelf.position}`} up`}
                            disabled={!shelfAbove || swapping}
                            onClick={() => shelfAbove && handleSwapShelves(shelf, shelfAbove)}
                          >
                            <ArrowUp className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            aria-label={`Move ${shelf.label || `Shelf ${shelf.position}`} down`}
                            disabled={!shelfBelow || swapping}
                            onClick={() => shelfBelow && handleSwapShelves(shelf, shelfBelow)}
                          >
                            <ArrowDown className="h-3 w-3" />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {reorderError && (
        <Alert variant="destructive">
          <AlertDescription>{reorderError}</AlertDescription>
        </Alert>
      )}

      <Dialog open={addShelfFor !== null} onOpenChange={(open) => !open && setAddShelfFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add shelf to {addShelfFor?.name}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAddShelf} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="shelf-label">Label</Label>
              <Input id="shelf-label" value={newShelfLabel} onChange={(e) => setNewShelfLabel(e.target.value)} />
            </div>
            {shelfError && (
              <Alert variant="destructive">
                <AlertDescription>{shelfError}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="submit" disabled={savingShelf}>
                {savingShelf ? "Saving…" : "Add"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={editShelf !== null} onOpenChange={(open) => !open && setEditShelf(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit shelf label</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditShelf} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="edit-shelf-label">Label</Label>
              <Input
                id="edit-shelf-label"
                value={editShelfLabel}
                onChange={(e) => setEditShelfLabel(e.target.value)}
              />
            </div>
            {editShelfError && (
              <Alert variant="destructive">
                <AlertDescription>{editShelfError}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="submit" disabled={savingEditShelf}>
                {savingEditShelf ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
