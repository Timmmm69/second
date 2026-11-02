import { createContext, useContext } from "react";
import type { Category, Item, Settings, User } from "./types";
export interface AppContextValue {
  user: User | null;
  dev: boolean;
  demo: boolean;
  settings: Settings | null;
  categories: Category[];
  refreshCategories: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  selection: Item[];
  selectionIds: string[];
  setSelection: (ids: string[]) => Promise<void>;
  refreshSelection: () => Promise<void>;
  go: (path: string) => void;
  path: string;
  refreshUser: () => Promise<void>;
  toast: (text: string) => void;
  authenticated: () => boolean;
  offline: boolean;
  ownerCode: string;
  setOwnerCode: (code: string) => void;
}
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("App context missing");
  return context;
}
