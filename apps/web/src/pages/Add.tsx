import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useHousehold } from "../lib/household-context.js";
import { api } from "../lib/api.js";
import { type Ownership } from "../lib/labels.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Button } from "../components/ui/button.js";
import { Switch } from "../components/ui/switch.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";

type EditionLookup = {
  isbn: string;
  title: string;
  authors: string;
  language?: string;
  publisher?: string;
  published_year?: number;
  cover_url?: string;
};

type Shelf = { id: string; position: number; label: string; updated_at: string };
type Bookcase = { id: string; name: string; updated_at: string; shelves: Shelf[] };

const NO_SHELF = "none";

export function Add() {
  const { household } = useHousehold();

  const [activeTab, setActiveTab] = useState<"isbn" | "manual">("isbn");
  const [revealed, setRevealed] = useState(false);
  const [lookupNotice, setLookupNotice] = useState("");
  const [lookingUp, setLookingUp] = useState(false);

  const [title, setTitle] = useState("");
  const [authors, setAuthors] = useState("");
  const [isbn, setIsbn] = useState("");
  const [language, setLanguage] = useState("");
  const [coverUrl, setCoverUrl] = useState("");
  const [shelfId, setShelfId] = useState(NO_SHELF);
  const [ownership, setOwnership] = useState<Ownership>("owned");
  const [batchMode, setBatchMode] = useState(false);

  const [bookcases, setBookcases] = useState<Bookcase[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const isbnInputRef = useRef<HTMLInputElement>(null);

  // Shelf selection is optional and non-critical to this screen's core job
  // (adding a book) — if the bookcases fetch fails we degrade quietly to an
  // empty shelf list (just the "No shelf" option) rather than blocking the
  // form with an error banner.
  useEffect(() => {
    let cancelled = false;
    api<{ bookcases: Bookcase[] }>(`/api/bookcases?householdId=${household.id}`)
      .then((data) => {
        if (!cancelled) setBookcases(data.bookcases);
      })
      .catch(() => {
        if (!cancelled) setBookcases([]);
      });
    return () => {
      cancelled = true;
    };
  }, [household.id]);

  // Explicit "Look up" click rather than auto-lookup on blur/Enter: ISBNs are
  // often pasted or scanned in fragments, and auto-firing on every blur would
  // mean redundant/partial lookups. A single explicit trigger is predictable.
  async function handleLookup() {
    const value = isbn.trim();
    if (!value) return;
    setLookingUp(true);
    setSubmitError("");
    try {
      const data = await api<EditionLookup>(`/api/editions/lookup?isbn=${encodeURIComponent(value)}`);
      setTitle(data.title);
      setAuthors(data.authors ?? "");
      setIsbn(data.isbn || value);
      setLanguage(data.language ?? "");
      setCoverUrl(data.cover_url ?? "");
      setLookupNotice("");
    } catch {
      // We don't distinguish a 404 "not found" miss from any other lookup
      // failure (network error, etc.) — either way the right move is the
      // same: fall through to an empty manual form seeded with the ISBN the
      // user typed, never block on it.
      setTitle("");
      setAuthors("");
      setLanguage("");
      setCoverUrl("");
      setLookupNotice("No match found — enter the details manually");
    } finally {
      setLookingUp(false);
      setRevealed(true);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError("");
    if (!title.trim()) {
      setSubmitError("Title is required.");
      return;
    }

    setSubmitting(true);
    try {
      await api<{ book: unknown }>("/api/books", {
        method: "POST",
        body: JSON.stringify({
          householdId: household.id,
          edition: {
            isbn: isbn.trim() || undefined,
            title: title.trim(),
            authors: authors.trim() || undefined,
            language: language.trim() || undefined,
            cover_url: coverUrl || undefined,
          },
          ownership,
          shelf_id: shelfId === NO_SHELF ? undefined : shelfId,
        }),
      });

      toast(`Added "${title.trim()}"`);

      // Always clear the book-specific fields on success. In batch mode we
      // keep the shelf + ownership selection (and stay revealed, so the next
      // ISBN/manual entry can go straight in); outside batch mode we reset
      // those too and go back to the ISBN tab's initial state.
      setTitle("");
      setAuthors("");
      setIsbn("");
      setLanguage("");
      setCoverUrl("");
      setLookupNotice("");

      if (batchMode) {
        isbnInputRef.current?.focus();
      } else {
        setShelfId(NO_SHELF);
        setOwnership("owned");
        setRevealed(false);
        setActiveTab("isbn");
      }
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function renderSharedFields() {
    return (
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="add-title">Title</Label>
          <Input
            id="add-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="add-authors">Authors</Label>
          <Input id="add-authors" value={authors} onChange={(e) => setAuthors(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="add-language">Language</Label>
          <Input id="add-language" value={language} onChange={(e) => setLanguage(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="add-shelf">Shelf</Label>
          <Select value={shelfId} onValueChange={setShelfId}>
            <SelectTrigger id="add-shelf" className="w-full">
              <SelectValue placeholder="No shelf" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SHELF}>No shelf</SelectItem>
              {bookcases.map((bookcase) => (
                <SelectGroup key={bookcase.id}>
                  <SelectLabel>{bookcase.name}</SelectLabel>
                  {bookcase.shelves.map((shelf) => (
                    <SelectItem key={shelf.id} value={shelf.id}>
                      {shelf.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="add-ownership">Ownership</Label>
          <Select value={ownership} onValueChange={(v) => setOwnership(v as Ownership)}>
            <SelectTrigger id="add-ownership" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="owned">Owned</SelectItem>
              <SelectItem value="borrowed_in">Borrowed</SelectItem>
              <SelectItem value="wishlist">Wishlist</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Add a book</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "isbn" | "manual")}>
          <TabsList>
            <TabsTrigger value="isbn">ISBN</TabsTrigger>
            <TabsTrigger value="manual">Manual</TabsTrigger>
          </TabsList>

          <TabsContent value="isbn" className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="add-isbn-lookup">ISBN</Label>
              <div className="flex gap-2">
                <Input
                  id="add-isbn-lookup"
                  ref={isbnInputRef}
                  value={isbn}
                  onChange={(e) => setIsbn(e.target.value)}
                  placeholder="978..."
                />
                <Button type="button" onClick={handleLookup} disabled={lookingUp || !isbn.trim()}>
                  {lookingUp ? "Looking up…" : "Look up"}
                </Button>
              </div>
            </div>

            {lookupNotice && <p className="text-sm text-muted-foreground">{lookupNotice}</p>}

            {revealed && renderSharedFields()}
          </TabsContent>

          <TabsContent value="manual" className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="add-manual-isbn">ISBN</Label>
              <Input id="add-manual-isbn" value={isbn} onChange={(e) => setIsbn(e.target.value)} />
            </div>
            {renderSharedFields()}
          </TabsContent>
        </Tabs>

        <div className="flex items-center gap-2">
          <Switch id="add-batch-mode" checked={batchMode} onCheckedChange={setBatchMode} />
          <Label htmlFor="add-batch-mode">Batch mode (keep shelf &amp; ownership between adds)</Label>
        </div>

        {submitError && (
          <Alert variant="destructive">
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" disabled={submitting}>
          {submitting ? "Adding…" : "Add book"}
        </Button>
      </form>
    </div>
  );
}
