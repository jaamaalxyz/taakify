import { useRef, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { useHousehold } from "../lib/household-context.js";
import {
  importGoodreadsCsv,
  previewGoodreadsCsv,
  type ImportRowFailure,
} from "../lib/repo/import.js";
import { friendlyError } from "../lib/error-messages.js";
import { Label } from "../components/ui/label.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";

const FILE_ERROR_MESSAGES = {
  not_goodreads:
    "This doesn't look like a Goodreads export. Export your library from Goodreads (My Books → Import/Export) and upload that CSV.",
  no_books: "No books found in this file.",
} as const;

// File selected and parsed, waiting for the user to confirm before any
// write happens.
interface PendingImport {
  fileName: string;
  csvText: string;
  bookCount: number;
  errorCount: number;
}

export function Import() {
  const { household, user } = useHousehold();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState("");
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [importing, setImporting] = useState(false);
  // Ref, not state: the shouldCancel closure passed into importGoodreadsCsv
  // captures this ref once, so clicking Cancel is visible to the running
  // loop without re-creating the closure.
  const cancelRequestedRef = useRef(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<{
    imported: number;
    totalRows: number;
    cancelled: boolean;
  } | null>(null);
  const [failures, setFailures] = useState<ImportRowFailure[]>([]);
  const [topError, setTopError] = useState("");

  function resetResults() {
    setFileError("");
    setPending(null);
    setSummary(null);
    setFailures([]);
    setProgress(null);
    setTopError("");
    setCancelRequested(false);
    cancelRequestedRef.current = false;
  }

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    resetResults();
    setFileName(file.name);
    try {
      const csvText = await file.text();
      const preview = previewGoodreadsCsv(csvText);
      if (preview.fileError) {
        setFileError(FILE_ERROR_MESSAGES[preview.fileError]);
      } else {
        setPending({
          fileName: file.name,
          csvText,
          bookCount: preview.bookCount,
          errorCount: preview.errorCount,
        });
      }
    } catch (err) {
      setTopError(friendlyError(err));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleImport() {
    if (!pending) return;
    setImporting(true);
    setCancelRequested(false);
    cancelRequestedRef.current = false;
    try {
      const result = await importGoodreadsCsv(pending.csvText, {
        householdId: household.id,
        userId: user.id,
        onProgress: (done, total) => setProgress({ done, total }),
        shouldCancel: () => cancelRequestedRef.current,
      });
      setSummary({ imported: result.imported, totalRows: result.totalRows, cancelled: result.cancelled });
      setFailures(result.failures);
      setPending(null);
    } catch (err) {
      setTopError(friendlyError(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Import from Goodreads</h1>
      <p className="text-sm text-muted-foreground">
        Export your library from Goodreads (My Books → Import/Export) and upload the CSV here. Each
        row becomes a book in {household.name}, with your reading status and rating carried over.
        Books already in your library are skipped, and you'll see a report for anything that couldn't
        be imported.
      </p>

      <div className="space-y-1">
        <Label htmlFor="import-file">Goodreads CSV export</Label>
        <input
          id="import-file"
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={handleFileChange}
          disabled={importing}
        />
      </div>

      {fileError && (
        <Alert variant="destructive">
          <AlertDescription>{fileError}</AlertDescription>
        </Alert>
      )}

      {pending && (
        <Alert>
          <AlertDescription className="space-y-2">
            <span className="block">
              Found {pending.bookCount} book{pending.bookCount === 1 ? "" : "s"} in {pending.fileName}.
              {pending.errorCount > 0 &&
                ` ${pending.errorCount} row(s) have problems and will be reported after importing.`}
            </span>
            <span className="block">Import them into {household.name}?</span>
            <span className="flex gap-2">
              <Button onClick={handleImport}>Import {pending.bookCount} books</Button>
              <Button variant="outline" onClick={resetResults}>
                Choose another file
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      )}

      {importing && progress && (
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            Importing {fileName}: {progress.done} of {progress.total}…
          </p>
          {!cancelRequested ? (
            <Button variant="outline" size="sm" onClick={() => {
                setCancelRequested(true);
                cancelRequestedRef.current = true;
              }}>
              Cancel import
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">Stopping after the current book…</p>
          )}
        </div>
      )}

      {topError && (
        <Alert variant="destructive">
          <AlertDescription>{topError}</AlertDescription>
        </Alert>
      )}

      {summary && (
        <Alert>
          <AlertDescription className="space-y-2">
            <span className="block">
              {summary.cancelled
                ? `Import cancelled — ${summary.imported} book(s) were imported before stopping.`
                : `Imported ${summary.imported} of ${summary.totalRows} rows.`}
              {failures.length > 0 && ` ${failures.length} row(s) were skipped or had errors — see below.`}
            </span>
            <span className="block">
              <Link to="/library" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
                Go to your library →
              </Link>
            </span>
          </AlertDescription>
        </Alert>
      )}

      {failures.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Row</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {failures.map((f) => (
              <TableRow key={f.rowNumber}>
                <TableCell>{f.rowNumber}</TableCell>
                <TableCell>{f.title || "—"}</TableCell>
                <TableCell>{f.message}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
