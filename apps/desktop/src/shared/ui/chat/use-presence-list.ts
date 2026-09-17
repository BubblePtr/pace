import { useCallback, useLayoutEffect, useRef, useState } from "react";

export type PresenceMotion = "none" | "enter" | "exit";

export type PresenceRecord<T> = {
  item: T;
  key: string;
  motion: PresenceMotion;
};

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function membershipKey<T>(records: PresenceRecord<T>[]) {
  return records.map((record) => `${record.key}:${record.motion}`).join("\0");
}

function mergePresence<T>(
  previous: PresenceRecord<T>[],
  items: readonly T[],
  getKey: (item: T) => string,
  isFirst: boolean,
  reduceMotion: boolean,
): PresenceRecord<T>[] {
  const liveByKey = new Map(items.map((item) => [getKey(item), item]));
  const previousByKey = new Map(previous.map((record) => [record.key, record]));
  const merged: PresenceRecord<T>[] = items.map((item) => {
    const key = getKey(item);
    const previousRecord = previousByKey.get(key);

    return {
      item,
      key,
      motion: !previousRecord
        ? isFirst || reduceMotion
          ? "none"
          : "enter"
        : previousRecord.motion === "exit"
          ? "none"
          : previousRecord.motion,
    };
  });

  if (!reduceMotion) {
    for (let index = 0; index < previous.length; index += 1) {
      const record = previous[index];
      if (liveByKey.has(record.key)) {
        continue;
      }
      merged.splice(Math.min(index, merged.length), 0, {
        item: record.item,
        key: record.key,
        motion: "exit",
      });
    }
  }

  return merged;
}

/**
 * Holds list rows through their exit transition. First paint is idle so a
 * session that already has rows does not play enter on load; later inserts
 * and removals are the user-caused changes that should move.
 */
export function usePresenceList<T>(
  items: readonly T[],
  getKey: (item: T) => string,
  options?: { exitTimeoutMs?: number },
) {
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const getKeyRef = useRef(getKey);
  getKeyRef.current = getKey;
  const firstRef = useRef(true);
  const [records, setRecords] = useState<PresenceRecord<T>[]>(() =>
    mergePresence([], items, getKey, true, prefersReducedMotion()),
  );

  const signature = items.map((item) => getKey(item)).join("\0");

  useLayoutEffect(() => {
    const reduceMotion = prefersReducedMotion();
    setRecords((previous) => {
      const next = mergePresence(
        previous,
        itemsRef.current,
        getKeyRef.current,
        firstRef.current,
        reduceMotion,
      );
      firstRef.current = false;
      return membershipKey(previous) === membershipKey(next) ? previous : next;
    });
  }, [signature]);

  const onExitTransitionEnd = useCallback((key: string) => {
    setRecords((previous) => {
      const next = previous.filter(
        (record) => !(record.key === key && record.motion === "exit"),
      );
      return next.length === previous.length ? previous : next;
    });
  }, []);

  const exitTimeoutMs = options?.exitTimeoutMs;
  const exitingSignature = records
    .filter((record) => record.motion === "exit")
    .map((record) => record.key)
    .join("\0");

  useLayoutEffect(() => {
    if (!exitTimeoutMs || !exitingSignature) {
      return;
    }

    const keys = exitingSignature.split("\0");
    const timers = keys.map((key) =>
      window.setTimeout(() => onExitTransitionEnd(key), exitTimeoutMs),
    );
    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [exitTimeoutMs, exitingSignature, onExitTransitionEnd]);

  const liveByKey = new Map(items.map((item) => [getKey(item), item]));
  const present = records.map((record) =>
    record.motion === "exit"
      ? record
      : { ...record, item: liveByKey.get(record.key) ?? record.item },
  );

  return { present, onExitTransitionEnd };
}
