import { useState } from "react";
import { command } from "./api";
import { useApp } from "./context";
import { Button, Empty, ErrorBox, Field } from "./ui";

export default function Invite() {
  const { user, refreshUser, toast, go, demo } = useApp();
  const [token, setToken] = useState(""),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  if (demo) return <div className="page narrow"><Empty title="Вход сотрудников">Доступ команды открывается в приложении магазина после приглашения владельца.</Empty></div>;
  return (
    <div className="page narrow">
      <h1>Приглашение сотрудника</h1>
      <p>
        Приглашение действует только для Telegram-аккаунта, которому владелец
        назначил доступ.
      </p>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await command("/me/staff-invite", { token });
            await refreshUser();
            toast("Доступ сотрудника подтверждён");
            go("/staff/queue");
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field
          label="Код приглашения"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          autoComplete="off"
        />
        <ErrorBox error={error} />
        <Button type="submit" disabled={!user || busy}>
          {busy ? "Проверяем…" : "Принять приглашение"}
        </Button>
        {!user && <p>Сначала откройте Mini App через Telegram.</p>}
      </form>
    </div>
  );
}
