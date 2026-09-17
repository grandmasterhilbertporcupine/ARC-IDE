import { useCallback, useState } from "react";
import type { z } from "zod";

export function useRetainedRequest<T>(key: string, schema: z.ZodType<T>) {
  const [value, setValue] = useState<T | null>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw === null) return null;
      const parsed = schema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  });
  const [storageError, setStorageError] = useState<string | null>(null);
  const retain = useCallback(
    (next: T | null) => {
      setValue(next);
      try {
        if (next === null) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, JSON.stringify(next));
        setStorageError(null);
      } catch {
        setStorageError(
          "This browser could not retain the request across reloads. Keep this view open to retry the same request.",
        );
      }
    },
    [key],
  );
  return { value, retain, storageError };
}
