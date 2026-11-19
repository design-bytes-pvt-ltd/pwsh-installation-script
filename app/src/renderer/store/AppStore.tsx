import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import { initialState, reducer, type Action, type AppState } from './reducer';

const StateContext = createContext<AppState | null>(null);
const DispatchContext = createContext<Dispatch<Action> | null>(null);

export function AppStoreProvider({ children, initial = initialState }: { children: ReactNode; initial?: AppState }) {
  const [state, dispatch] = useReducer(reducer, initial);
  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useAppState(): AppState {
  const state = useContext(StateContext);
  if (!state) throw new Error('useAppState must be used inside <AppStoreProvider>');
  return state;
}

export function useAppDispatch(): Dispatch<Action> {
  const dispatch = useContext(DispatchContext);
  if (!dispatch) throw new Error('useAppDispatch must be used inside <AppStoreProvider>');
  return dispatch;
}
