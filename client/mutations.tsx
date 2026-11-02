import { useRef, useState } from "react";
import {
  api,
  ApiError,
  command,
  operationKey,
  readLocal,
  saveLocal,
} from "./api";
import { Button, ErrorBox } from "./ui";
import { useApp } from "./context";
interface Pending {
  key: string;
  path: string;
}
export function useMutation() {
  const { ownerCode } = useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [pending, setPending] = useState<Pending | null>(() =>
      readLocal("staff-operation", null),
    );
  const pendingRef = useRef(pending);
  const run = async <T,>(
    path: string,
    body: unknown = {},
    method = "POST",
  ): Promise<T | undefined> => {
    if (busy) return;
    const existing = pendingRef.current;
    if (existing && existing.path !== path) {
      setError(new Error("Сначала проверьте результат предыдущей операции."));
      return;
    }
    const op = existing || { key: operationKey(), path };
    pendingRef.current = op;
    saveLocal("staff-operation", op);
    setBusy(true);
    setError(null);
    try {
      const result = await command<T>(
        path,
        body,
        method,
        op.key,
        path.startsWith("/owner/") ? ownerCode : undefined,
      );
      pendingRef.current = null;
      setPending(null);
      saveLocal("staff-operation", null);
      return result;
    } catch (e) {
      setError(e);
      if (e instanceof ApiError && e.status === 0) setPending(op);
      else {
        pendingRef.current = null;
        setPending(null);
        saveLocal("staff-operation", null);
      }
    } finally {
      setBusy(false);
    }
  };
  const recovery = (
    <div>
      <ErrorBox error={error} />
      {pending && (
        <div className="notice">
          <strong>Проверяем результат операции</strong>
          <p>
            До выяснения результата не передавайте вещь повторно и не создавайте
            новую операцию.
          </p>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await api<{
                  id?: string;
                  items?: { id: string }[];
                }>(`/operations/${pending.key}`);
                if (
                  pending.path === "/staff/availability-operations" &&
                  result.id
                )
                  saveLocal("counter-operation", {
                    id: result.id,
                    itemIds: result.items?.map((i) => i.id) || [],
                  });
                pendingRef.current = null;
                setPending(null);
                saveLocal("staff-operation", null);
                location.reload();
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Проверить результат
          </Button>
        </div>
      )}
    </div>
  );
  return { run, busy, error, setError, recovery };
}
