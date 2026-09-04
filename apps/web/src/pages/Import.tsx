import { useRef, useState, type ChangeEvent } from "react";
import { useHousehold } from "../lib/household-context.js";
import { importGoodreadsCsv, type ImportRowFailure } from "../lib/repo/import.js";
import { friendlyError } from "../lib/error-messages.js";
import { Label } from "../components/ui/label.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";

export function Import() {
  const { household, user } = useHousehold();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<{ imported: number; totalRows: number } | null>(null);
  const [failures, setFailures] = useState<ImportRowFailure[]>([]);
  const [topError, setTopError] = useState("");

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setTopError("");
    setSummary(null);
    setFailures([]);
    setProgress(null);
    setImporting(true);
    try {
      const text = await file.text();
      const result = await importGoodreadsCsv(text, {
        householdId: household.id,
        userId: user.id,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setSummary({ imported: result.imported, totalRows: result.totalRows });
      setFailures(result.failures);
    } catch (err) {
      setTopError(friendlyError(err));
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Import from Goodreads</h1>
      <p className="text-sm text-muted-foreground">
        Export your library from Goodreads (My Books → Import/Export) and upload the CSV here. Each
        row becomes a book, with your reading status and rating carried over.
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

      {importing && progress && (
        <p className="text-sm text-muted-foreground">
          Importing {fileName}: {progress.done} of {progress.total}…
        </p>
      )}

      {topError && (
        <Alert variant="destructive">
          <AlertDescription>{topError}</AlertDescription>
        </Alert>
      )}

      {summary && (
        <Alert>
          <AlertDescription>
            Imported {summary.imported} of {summary.totalRows} rows.
            {failures.length > 0 && ` ${failures.length} row(s) had errors — see below.`}
          </AlertDescription>
        </Alert>
      )}

      {failures.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Row</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Error</TableHead>
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
