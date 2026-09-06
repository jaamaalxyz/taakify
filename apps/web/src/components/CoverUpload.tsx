import { useRef, useState } from "react";
import { Camera } from "lucide-react";
import { toast } from "sonner";
import { toCoverDataUrl } from "../lib/cover-image.js";
import { uploadEditionCover } from "../lib/repo/editions.js";
import { friendlyError } from "../lib/error-messages.js";

// "Add cover photo" tile for editions with no online cover (spec Goal #6:
// local titles are first-class — ISBN lookup often fails for local books).
// Renders where a cover preview would sit, matching its aspect ratio.
//
// The pick → downscale → enqueue pipeline is fully offline-capable: the
// outbox row survives restarts and uploads on reconnect, and the optimistic
// mirror write makes the photo appear immediately.
export function CoverUpload({ editionId }: { editionId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so picking the same file again re-fires onChange (retry case).
    e.target.value = "";
    if (!file) return;

    setBusy(true);
    try {
      const dataUrl = await toCoverDataUrl(file);
      await uploadEditionCover(editionId, dataUrl);
      toast("Cover added");
    } catch (err) {
      toast(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="flex aspect-[2/3] w-24 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50"
      onClick={() => inputRef.current?.click()}
      disabled={busy}
      aria-label="Add cover photo"
    >
      <Camera className="h-5 w-5" aria-hidden="true" />
      <span className="px-1 text-center text-[10px] leading-tight">
        {busy ? "Adding…" : "Add cover photo"}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={handlePick}
      />
    </button>
  );
}
