// Shared loading/error/retry state machine for one Home-screen section.
// Each section calls this independently (own loader, own deps) rather than
// Home.tsx combining all four into one Promise.all -- a slow or failing
// section must never block, hide, or delay another (design-spec gap #3).
import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyError } from "../lib/error-messages.js";

export type HomeSectionStatus = "loading" | "error" | "loaded";

export interface UseHomeSectionResult<T> {
  status: HomeSectionStatus;
  data: T[] | null;
  error: string | null;
  reload: () => void;
}

interface HomeSectionState<T> {
  status: HomeSectionStatus;
  data: T[] | null;
  error: string | null;
}

export function useHomeSection<T>(
  loader: () => Promise<T[]>,
  deps: readonly unknown[]
): UseHomeSectionResult<T> {
  const [state, setState] = useState<HomeSectionState<T>>({ status: "loading", data: null, error: null });
  // Read through a ref so `run` doesn't need `loader` in its own deps --
  // callers pass a fresh closure every render (same pattern as
  // BarcodeScanner's onDetectedRef, Plan 5).
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  // Guards against a slow, superseded request overwriting a newer one's
  // result -- only the result whose id still matches the latest run wins.
  const runIdRef = useRef(0);

  const run = useCallback(() => {
    const runId = ++runIdRef.current;
    setState({ status: "loading", data: null, error: null });
    loaderRef
      .current()
      .then((data) => {
        if (runIdRef.current !== runId) return;
        setState({ status: "loaded", data, error: null });
      })
      .catch((err) => {
        if (runIdRef.current !== runId) return;
        setState({ status: "error", data: null, error: friendlyError(err) });
      });
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` IS the
  // caller-controlled dependency list; `run` is stable (empty deps above).
  useEffect(() => {
    run();
  }, deps);

  return { status: state.status, data: state.data, error: state.error, reload: run };
}
