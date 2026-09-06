// Edition repo (Plan 7): cover photo upload. Enqueued through the offline
// outbox (JSON body — replays like any other write, surviving restarts and
// offline photo captures per spec §7), with an optimistic mirror write so
// the cover preview appears instantly.
import { enqueue } from "../sync/outbox.js";
import { OPTIMISTIC_UPDATED_AT } from "../sync/optimistic-clock.js";
import type { UploadCoverRequest } from "@taakify/shared";

export async function uploadEditionCover(editionId: string, dataUrl: string): Promise<void> {
  const body: UploadCoverRequest = { data_url: dataUrl };
  await enqueue(
    `/api/editions/${editionId}/cover`,
    "POST",
    body,
    {
      // The data URL doubles as the instant local preview; when the server
      // processes the upload, Electric streams back the real object URL and
      // the same row's LWW upsert replaces it. updated_at uses the
      // far-past sentinel (not now()) for the same clock-skew reason as
      // every other repo write: a browser clock running fast must never
      // make the server's real row lose the LWW comparison and strand the
      // mirror on the giant data-URL "cover" forever.
      sql: `UPDATE edition SET cover_url = $2, updated_at = $3 WHERE id = $1`,
      params: [editionId, dataUrl, OPTIMISTIC_UPDATED_AT],
      touched: [{ table: "edition", id: editionId }],
    }
  );
}
