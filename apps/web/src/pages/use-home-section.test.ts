import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHomeSection } from "./use-home-section.js";

describe("useHomeSection", () => {
  it("starts in loading, then resolves to loaded with the loader's data", async () => {
    const loader = vi.fn().mockResolvedValue([{ id: "1" }]);
    const { result } = renderHook(() => useHomeSection(loader, []));

    expect(result.current.status).toBe("loading");
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(result.current.data).toEqual([{ id: "1" }]);
    expect(result.current.error).toBeNull();
  });

  it("transitions to error, with a friendly message, on a rejected loader", async () => {
    const loader = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useHomeSection(loader, []));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeTruthy();
  });

  it("reload() re-invokes the loader and re-enters loading", async () => {
    const loader = vi.fn().mockResolvedValueOnce([{ id: "1" }]).mockResolvedValueOnce([{ id: "2" }]);
    const { result } = renderHook(() => useHomeSection(loader, []));
    await waitFor(() => expect(result.current.status).toBe("loaded"));

    act(() => result.current.reload());

    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.data).toEqual([{ id: "2" }]));
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("re-runs the loader when a dep changes", async () => {
    const loader = vi.fn().mockResolvedValue([]);
    const { rerender } = renderHook(({ dep }: { dep: number }) => useHomeSection(loader, [dep]), {
      initialProps: { dep: 1 },
    });
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));

    rerender({ dep: 2 });

    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  });

  it("ignores a stale response that resolves after a newer reload already resolved", async () => {
    let resolveFirst!: (v: { id: string }[]) => void;
    const first = new Promise<{ id: string }[]>((resolve) => {
      resolveFirst = resolve;
    });
    const loader = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce([{ id: "new" }]);
    const { result } = renderHook(() => useHomeSection(loader, []));

    act(() => result.current.reload()); // second call -- resolves before the first
    await waitFor(() => expect(result.current.data).toEqual([{ id: "new" }]));

    resolveFirst([{ id: "stale" }]); // first call resolves after the second already landed
    await new Promise((r) => setTimeout(r, 0));

    expect(result.current.data).toEqual([{ id: "new" }]); // stale result ignored
  });
});
