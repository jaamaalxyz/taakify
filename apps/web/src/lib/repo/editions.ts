// Edition repo (Plan 7): cover photo upload. Enqueued through the offline
// outbox (JSON body — replays like any other write, surviving restarts and
// offline photo captures per spec §7), with an optimistic mirror write so
// the cover preview appears instantly.
import { enqueue } from "../sync/outbox.js";

export async function uploadEditionCover(editionId: string, dataUrl: string): Promise<void> {
  await enqueue(
    `/api/editions/${editionId}/cover`,
    "POST",
    { data_url: dataUrl },
    {
      // The data URL doubles as the instant local preview; when the server
      // processes the upload, Electric streams back the real object URL and
      // the same row's LWW upsert replaces it. Bumping updated_at keeps the
      // local write from being clobbered by an older streamed row.
      sql: `UPDATE edition SET cover_url = $2, updated_at = now() WHERE id = $1`,
      params: [editionId, dataUrl],
      touched: [{ table: "edition", id: editionId }],
    }
  );
}
