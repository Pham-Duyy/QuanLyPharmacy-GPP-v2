import { createContext, useContext } from "react";
import type { PreviewAction } from "./preview-reducer.js";
import type { PreviewState } from "./preview-types.js";

export type PreviewContextValue = {
  state: PreviewState;
  dispatch: (action: PreviewAction) => void;
};

export const PreviewContext = createContext<PreviewContextValue | null>(null);

export function usePreview(): PreviewContextValue {
  const value = useContext(PreviewContext);
  if (!value) throw new Error("usePreview phải nằm trong PreviewProvider");
  return value;
}
